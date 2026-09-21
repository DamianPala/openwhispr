# Publishing a fork prerelease

This fork publishes unsigned Windows/macOS/Linux installers as GitHub
prereleases under `DamianPala/openwhispr`. It never uses upstream's
`release.yml` (needs signing secrets this fork doesn't have) and
`build-and-notarize.yml` stays a two-line diff from upstream, so publishing
lives in its own workflow, `fork-prerelease.yml`.

## The two-dispatch procedure

1. Build:

   ```bash
   gh workflow run build-and-notarize.yml --ref daily
   ```

   Wait for it to finish, then note its run id (`gh run list --workflow build-and-notarize.yml --branch daily -L 1`).

2. Publish:

   ```bash
   gh workflow run fork-prerelease.yml --ref daily -f release_tag=v1.10.2-soniox.N -f run_id=<run id from step 1>
   ```

   `--ref daily` on both dispatches: the fork's default branch is upstream's
   `main`, which carries neither `fork-prerelease.yml` nor the fork's
   `build-and-notarize.yml` changes, so a dispatch without `--ref` runs the
   wrong file or none at all.

   `fork-prerelease.yml` checks that the run succeeded and was a
   `Build and Notarize` run, resolves its head commit, downloads its
   artifacts, and runs `scripts/ci/publish-prerelease.sh` against them.

## If an upload fails

Rerun only `fork-prerelease.yml` with the same `release_tag` and `run_id`.
The script reuses the existing draft release and re-uploads with `--clobber`,
so nothing rebuilds. This only works while the build's artifacts still exist.

## The 7-day window

`build-and-notarize.yml` uploads each platform's installers with
`retention-days: 7` (upstream's own value). A `run_id` older than that has no
artifacts left to download, and `fork-prerelease.yml` fails at the download
step; rebuild instead.

## Deleting an old prerelease

Once a newer release exists, delete the previous one (e.g. `-soniox.1` after
`-soniox.2` ships) so `latest` and download links stay unambiguous:

```bash
gh release delete v1.10.2-soniox.1 --repo DamianPala/openwhispr --yes
```

This does not touch the git tag; delete that separately if it should go too.
