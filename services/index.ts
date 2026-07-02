import { Layer } from "effect";
import { LowDBServiceLive } from "./db/LowDBAdapter";

export const ServiceLayerLive = Layer.provide(LowDBServiceLive);
