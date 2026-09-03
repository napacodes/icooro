function readPort(): number {
  const raw = process.env.API_PORT ?? "3001";
  const port = Number(raw);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("API_PORT must be a valid TCP port");
  }

  return port;
}

export const env = {
  port: readPort(),
};
