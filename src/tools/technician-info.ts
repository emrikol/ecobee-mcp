import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { resolveId } from "./set-temperature.js";
import {
  boundedString,
  optionalThermostatIdSchema,
  readOnlyAnnotations,
  registerEcobeeTool,
  structuredResult,
  toolError,
} from "./contracts.js";

const outputSchema = z.object({
  thermostatId: boundedString(64),
  thermostatName: boundedString(128),
  technician: z
    .object({
      contractorRef: boundedString(128),
      name: boundedString(256),
      phone: boundedString(64),
      streetAddress: boundedString(256),
      city: boundedString(128),
      provinceState: boundedString(128),
      country: boundedString(128),
      postalCode: boundedString(32),
      email: boundedString(320),
      web: boundedString(2_048),
    })
    .nullable(),
});

export function registerGetTechnicianInfo(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "get_technician_info",
    {
      description:
        "Get registered technician/contractor information for the thermostat.",
      inputSchema: z.object({ thermostatId: optionalThermostatIdSchema }),
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      const id = await resolveId(args.thermostatId, api, cache);

      const thermostats = await api.getThermostats({
        selectionType: "thermostats",
        selectionMatch: id,
        includeTechnician: true,
      });

      if (thermostats.length === 0) {
        return toolError("No thermostat found.");
      }

      const t = thermostats[0];
      const tech = t.technician;

      if (!tech) {
        return structuredResult(
          outputSchema,
          {
            thermostatId: t.identifier,
            thermostatName: t.name,
            technician: null,
          },
          "No technician/contractor registered for this thermostat.",
        );
      }

      return structuredResult(
        outputSchema,
        {
          thermostatId: t.identifier,
          thermostatName: t.name,
          technician: {
            contractorRef: tech.contractorRef,
            name: tech.name,
            phone: tech.phone,
            streetAddress: tech.streetAddress,
            city: tech.city,
            provinceState: tech.provinceState,
            country: tech.country,
            postalCode: tech.postalCode,
            email: tech.email,
            web: tech.web,
          },
        },
        { thermostat: t.name, technician: tech },
      );
    },
  );
}
