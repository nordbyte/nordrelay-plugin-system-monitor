export const COMMANDS = [
  "sample",
  "latest",
  "history",
  "panel-data",
  "series",
  "summary",
  "alerts",
  "notifications",
  "ack-alert",
  "export",
  "status",
  "storage",
  "storage-health",
  "checkpoint",
  "cleanup",
  "vacuum",
  "rebuild-rollups",
];

export function normalizeCommand(request) {
  return request.command || request.capabilityId || "";
}

export function isKnownCommand(command) {
  return COMMANDS.includes(command);
}
