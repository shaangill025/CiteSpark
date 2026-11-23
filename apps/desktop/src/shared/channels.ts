/** IPC channel names. Versioned: a renderer and main from different builds never half-understand each other. */
export const CHANNELS = Object.freeze({
  status: "citspark:status:v1",
  statusChanged: "citspark:status-changed:v1",
  request: "citspark:request:v1",
  restart: "citspark:restart:v1",
});
