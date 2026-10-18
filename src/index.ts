import { Hono } from "hono";
import { createApp } from "./http/app.js";

const app: Hono = createApp();

export default app;
