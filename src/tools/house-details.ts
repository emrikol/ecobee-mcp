import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import type { Thermostat } from "../ecobee/types.js";
import { resolveId } from "./set-temperature.js";

export function registerGetHouseDetails(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  server.registerTool(
    "get_house_details",
    {
      description:
        "Get house characteristics (style, size, floors, rooms, occupants, age, window efficiency).",
      inputSchema: {
        thermostatId: z
          .string()
          .optional()
          .describe(
            "Thermostat ID. Omit to use the first registered thermostat.",
          ),
      },
    },
    async (args) => {
      const id = await resolveId(args.thermostatId, api, cache);

      const thermostats = await api.getThermostats({
        selectionType: "thermostats",
        selectionMatch: id,
        includeHouseDetails: true,
      });

      if (thermostats.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No thermostat found." },
          ],
          isError: true,
        };
      }

      const t = thermostats[0];
      const details = t.houseDetails;

      if (!details) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No house details available.",
            },
          ],
        };
      }

      const result = {
        thermostat: t.name,
        houseDetails: details,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );
}

export function registerUpdateHouseDetails(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  server.registerTool(
    "update_house_details",
    {
      description:
        "Update house characteristics. Only provided fields are changed.",
      inputSchema: {
        thermostatId: z
          .string()
          .optional()
          .describe(
            "Thermostat ID. Omit to use the first registered thermostat.",
          ),
        style: z
          .string()
          .optional()
          .describe(
            "House style: other, apartment, condominium, detached, loft, multiPlex, rowHouse, semiDetached, townhouse",
          ),
        size: z.number().optional().describe("House size in square feet"),
        numberOfFloors: z.number().optional().describe("Number of floors"),
        numberOfRooms: z.number().optional().describe("Number of rooms"),
        numberOfOccupants: z
          .number()
          .optional()
          .describe("Number of occupants"),
        age: z.number().optional().describe("Age of house in years"),
        windowEfficiency: z
          .number()
          .optional()
          .describe("Window efficiency, 1-7"),
      },
    },
    async (args) => {
      const id = await resolveId(args.thermostatId, api, cache);

      const houseDetails: Partial<Thermostat["houseDetails"] & object> = {};
      if (args.style !== undefined) houseDetails.style = args.style;
      if (args.size !== undefined) houseDetails.size = args.size;
      if (args.numberOfFloors !== undefined)
        houseDetails.numberOfFloors = args.numberOfFloors;
      if (args.numberOfRooms !== undefined)
        houseDetails.numberOfRooms = args.numberOfRooms;
      if (args.numberOfOccupants !== undefined)
        houseDetails.numberOfOccupants = args.numberOfOccupants;
      if (args.age !== undefined) houseDetails.age = args.age;
      if (args.windowEfficiency !== undefined)
        houseDetails.windowEfficiency = args.windowEfficiency;

      if (Object.keys(houseDetails).length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: No fields provided to update.",
            },
          ],
          isError: true,
        };
      }

      await api.updateThermostat({
        selection: {
          selectionType: "thermostats",
          selectionMatch: id,
        },
        thermostat: { houseDetails } as Partial<Thermostat>,
      });

      cache.invalidate(id);

      return {
        content: [
          {
            type: "text" as const,
            text: `House details updated: ${Object.keys(houseDetails).join(", ")}`,
          },
        ],
      };
    },
  );
}
