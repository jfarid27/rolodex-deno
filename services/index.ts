import { Layer } from "effect";
import { LowDBServiceLive } from "./db/LowDBAdapter.ts";

export const ServiceLayerLive = Layer.provide(LowDBServiceLive);
