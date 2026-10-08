// ESM like providerHttpErrors.js: imported by the renderer and loaded by the main
// process through require(esm), so both sides agree on which streaming failures
// are a dead or missing connection (the ones that sound the error cue).

// The socket never opened: error, close before open, or the connect timeout.
export const STREAMING_CONNECTION_FAILED = "STREAMING_CONNECTION_FAILED";
// The socket dropped during the dictation and nothing brought it back.
export const STREAMING_CONNECTION_LOST = "STREAMING_CONNECTION_LOST";
// The cold-start buffer filled before the socket opened, so audio was discarded.
export const STREAMING_AUDIO_DROPPED = "STREAMING_AUDIO_DROPPED";

// The service answered with an error frame (auth, quota, ...) and ends the
// session. Sounds the cue only: the toast keeps the service's own wording.
export const STREAMING_SESSION_ERROR = "STREAMING_SESSION_ERROR";

// Soniox's file API refused the recording's container or codec. Not a
// connection error (no cue): the renderer retries once with a WAV copy.
export const ASYNC_INVALID_AUDIO = "PROVIDER_INVALID_AUDIO";

// The full transcription of a failed-over dictation failed and the streamed
// text was pasted instead. A notice, not a connection error (no cue of its own).
export const STREAMING_FAILOVER_STREAMED_TEXT = "STREAMING_FAILOVER_STREAMED_TEXT";

const CONNECTION_ERROR_CODES = new Set([
  STREAMING_CONNECTION_FAILED,
  STREAMING_CONNECTION_LOST,
  STREAMING_AUDIO_DROPPED,
  STREAMING_SESSION_ERROR,
]);

export const isStreamingConnectionError = (code) => CONNECTION_ERROR_CODES.has(code);
