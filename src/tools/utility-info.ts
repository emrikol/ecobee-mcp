import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { resolveId } from "./set-temperature.js";
import {
  boundedString,
  optionalThermostatInputSchema,
  readOnlyAnnotations,
  registerEcobeeTool,
  structuredResult,
  toolError,
} from "./contracts.js";

const outputSchema = z.object({
  thermostatId: boundedString(64),
  thermostatName: boundedString(128),
  utility: z
    .object({
      name: boundedString(256),
      phone: boundedString(64),
      email: boundedString(320),
      web: boundedString(2_048),
    })
    .nullable(),
});

export function registerGetUtilityInfo(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "get_utility_info",
    {
      description:
        "Get utility company information associated with the thermostat.",
      inputSchema: optionalThermostatInputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      const id = await resolveId(args.thermostatId, api, cache);

      const thermostats = await api.getThermostats({
        selectionType: "thermostats",
        selectionMatch: id,
        includeUtility: true,
      });

      if (thermostats.length === 0) {
        return toolError("No thermostat found.");
      }

      const t = thermostats[0];
      const utility = t.utility;

      if (!utility) {
        return structuredResult(
          outputSchema,
          {
            thermostatId: t.identifier,
            thermostatName: t.name,
            utility: null,
          },
          "No utility information available for this thermostat.",
        );
      }

      return structuredResult(
        outputSchema,
        {
          thermostatId: t.identifier,
          thermostatName: t.name,
          utility: {
            name: utility.name,
            phone: utility.phone,
            email: utility.email,
            web: utility.web,
          },
        },
        { thermostat: t.name, utility },
      );
    },
  );
}
