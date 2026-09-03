import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { APP_SERVICE_API } from "@icooro/shared";
import { env } from "./env.js";

const app = new Hono();

app.use(
  "*",
  cors({
    origin: ["http://localhost:3000"],
  }),
);

app.get("/health", (c) => {
  return c.json({
    ok: true,
    service: APP_SERVICE_API,
  });
});

serve(
  {
    fetch: app.fetch,
    port: env.port,
    hostname: "0.0.0.0",
  },
  (info) => {
    console.log(`${APP_SERVICE_API} listening on ${info.address}:${info.port}`);
  },
);
