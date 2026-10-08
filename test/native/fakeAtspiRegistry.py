#!/usr/bin/env python3
"""A minimal AT-SPI registry on a private bus, for linux-fast-paste --atspi-server.

usage: fakeAtspiRegistry.py <bus address>

It owns org.a11y.atspi.Registry and runs two applications ("kitty" and "gedit"), each
with one window. Commands on stdin, one per line, each answered with "ok" on stdout:
  focus <application>   that application's window becomes the only ACTIVE one
  add <application>     a new application appears, with an ACTIVE window
"ready" is printed once everything is registered. The process exits when stdin closes.
"""
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

ACCESSIBLE_XML = """
<node>
  <interface name="org.a11y.atspi.Accessible">
    <property name="Name" type="s" access="read"/>
    <property name="Description" type="s" access="read"/>
    <property name="Parent" type="(so)" access="read"/>
    <property name="ChildCount" type="i" access="read"/>
    <property name="Locale" type="s" access="read"/>
    <property name="AccessibleId" type="s" access="read"/>
    <property name="HelpText" type="s" access="read"/>
    <method name="GetChildAtIndex">
      <arg direction="in" type="i"/>
      <arg direction="out" type="(so)"/>
    </method>
    <method name="GetChildren"><arg direction="out" type="a(so)"/></method>
    <method name="GetIndexInParent"><arg direction="out" type="i"/></method>
    <method name="GetRelationSet"><arg direction="out" type="a(ua(so))"/></method>
    <method name="GetRole"><arg direction="out" type="u"/></method>
    <method name="GetRoleName"><arg direction="out" type="s"/></method>
    <method name="GetLocalizedRoleName"><arg direction="out" type="s"/></method>
    <method name="GetState"><arg direction="out" type="au"/></method>
    <method name="GetAttributes"><arg direction="out" type="a{ss}"/></method>
    <method name="GetApplication"><arg direction="out" type="(so)"/></method>
    <method name="GetInterfaces"><arg direction="out" type="as"/></method>
  </interface>
</node>
"""
INFO = Gio.DBusNodeInfo.new_for_xml(ACCESSIBLE_XML).interfaces[0]
ROOT = "/org/a11y/atspi/accessible/root"
REGISTRY = "org.a11y.atspi.Registry"
NULL_REF = ("", "/org/a11y/atspi/null")
ROLE_DESKTOP, ROLE_FRAME, ROLE_APPLICATION = 14, 23, 75
STATE_ACTIVE = 1


class Node:
    def __init__(self, conn, owner, path, name, role, parent_ref):
        self.owner, self.path, self.name, self.role = owner, path, name, role
        self.parent_ref = parent_ref
        self.children = []
        self.active = False
        self.application = self
        conn.register_object(path, INFO, self.on_method, self.on_get_property, None)

    def ref(self):
        return (self.owner, self.path)

    def on_get_property(self, conn, sender, path, iface, prop):
        return {
            "Name": GLib.Variant("s", self.name),
            "Description": GLib.Variant("s", ""),
            "Parent": GLib.Variant("(so)", self.parent_ref),
            "ChildCount": GLib.Variant("i", len(self.children)),
            "Locale": GLib.Variant("s", ""),
            "AccessibleId": GLib.Variant("s", ""),
            "HelpText": GLib.Variant("s", ""),
        }[prop]

    def on_method(self, conn, sender, path, iface, method, params, invocation):
        reply = {
            "GetChildren": lambda: GLib.Variant(
                "(a(so))", ([child.ref() for child in self.children],)
            ),
            "GetIndexInParent": lambda: GLib.Variant("(i)", (0,)),
            "GetRelationSet": lambda: GLib.Variant("(a(ua(so)))", ([],)),
            "GetRole": lambda: GLib.Variant("(u)", (self.role,)),
            "GetRoleName": lambda: GLib.Variant("(s)", ("fake",)),
            "GetLocalizedRoleName": lambda: GLib.Variant("(s)", ("fake",)),
            "GetState": lambda: GLib.Variant(
                "(au)", ([1 << STATE_ACTIVE if self.active else 0, 0],)
            ),
            "GetAttributes": lambda: GLib.Variant("(a{ss})", ({},)),
            "GetApplication": lambda: GLib.Variant("((so))", (self.application.ref(),)),
            "GetInterfaces": lambda: GLib.Variant("(as)", (["org.a11y.atspi.Accessible"],)),
        }.get(method)
        if method == "GetChildAtIndex":
            index = params.unpack()[0]
            ref = self.children[index].ref() if 0 <= index < len(self.children) else NULL_REF
            invocation.return_value(GLib.Variant("((so))", (ref,)))
        elif reply:
            invocation.return_value(reply())
        else:
            invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", method)


def connect(address):
    flags = (
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT
        | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION
    )
    return Gio.DBusConnection.new_for_address_sync(address, flags, None, None)


class Desktop:
    def __init__(self, address):
        self.address = address
        self.connections = []
        conn = connect(address)
        self.connections.append(conn)
        self.root = Node(conn, REGISTRY, ROOT, "main", ROLE_DESKTOP, NULL_REF)
        Gio.bus_own_name_on_connection(conn, REGISTRY, Gio.BusNameOwnerFlags.NONE, None, None)
        self.windows = {}

    def add_application(self, name):
        conn = connect(self.address)
        self.connections.append(conn)
        owner = conn.get_unique_name()
        app = Node(conn, owner, ROOT, name, ROLE_APPLICATION, (REGISTRY, ROOT))
        window = Node(conn, owner, ROOT + "/1", name + " window", ROLE_FRAME, (owner, ROOT))
        window.application = app
        app.children.append(window)
        self.root.children.append(app)
        self.windows[name] = window

    def focus(self, name):
        for window_name, window in self.windows.items():
            window.active = window_name == name


def main():
    desktop = Desktop(sys.argv[1])
    desktop.add_application("kitty")
    desktop.add_application("gedit")
    desktop.focus("kitty")
    loop = GLib.MainLoop()

    def on_stdin(fd, condition):
        line = sys.stdin.readline()
        if not line:
            loop.quit()
            return False
        verb, _, name = line.strip().partition(" ")
        if verb == "add":
            desktop.add_application(name)
        desktop.focus(name)
        print("ok", flush=True)
        return True

    GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP, on_stdin)
    print("ready", flush=True)
    loop.run()


main()
