import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import type { Thermostat } from "../ecobee/types.js";
import { resolveId } from "./set-temperature.js";
import {
  boundedString,
  finiteNumber,
  mutationAnnotations,
  mutationVerificationSchema,
  optionalThermostatIdSchema,
  readOnlyAnnotations,
  registerEcobeeTool,
  structuredResult,
  toolError,
} from "./contracts.js";

const houseDetailsSchema = z.object({
  style: boundedString(64),
  size: finiteNumber,
  numberOfFloors: finiteNumber,
  numberOfRooms: finiteNumber,
  numberOfOccupants: finiteNumber,
  age: finiteNumber,
  windowEfficiency: finiteNumber,
});

const readOutputSchema = z.object({
  thermostatId: boundedString(64),
  thermostatName: boundedString(128),
  houseDetails: houseDetailsSchema.nullable(),
});

const updateFieldsSchema = houseDetailsSchema.partial();
const mutationOutputSchema = z.object({
  thermostatId: boundedString(64),
  requestedChange: updateFieldsSchema,
  resultingState: z.object({
    houseDetails: houseDetailsSchema.nullable(),
    verification: mutationVerificationSchema,
  }),
});

export function registerGetHouseDetails(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "get_house_details",
    {
      description:
        "Get house characteristics (style, size, floors, rooms, occupants, age, window efficiency).",
      inputSchema: z.object({ thermostatId: optionalThermostatIdSchema }),
      outputSchema: readOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      const id = await resolveId(args.thermostatId, api, cache);

      const thermostats = await api.getThermostats({
        selectionType: "thermostats",
        selectionMatch: id,
        includeHouseDetails: true,
      });

      if (thermostats.length === 0) {
        return toolError("No thermostat found.");
      }

      const t = thermostats[0];
      const details = t.houseDetails;

      if (!details) {
        return structuredResult(
          readOutputSchema,
          {
            thermostatId: t.identifier,
            thermostatName: t.name,
            houseDetails: null,
          },
          "No house details available.",
        );
      }

      return structuredResult(
        readOutputSchema,
        {
          thermostatId: t.identifier,
          thermostatName: t.name,
          houseDetails: {
            style: details.style,
            size: details.size,
            numberOfFloors: details.numberOfFloors,
            numberOfRooms: details.numberOfRooms,
            numberOfOccupants: details.numberOfOccupants,
            age: details.age,
            windowEfficiency: details.windowEfficiency,
          },
        },
        { thermostat: t.name, houseDetails: details },
      );
    },
  );
}

export function registerUpdateHouseDetails(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  registerEcobeeTool(
    server,
    api,
    "update_house_details",
    {
      description:
        "Update house characteristics. Only provided fields are changed.",
      inputSchema: z.object({
        thermostatId: optionalThermostatIdSchema,
        style: boundedString(64)
          .optional()
          .describe(
            "House style: other, apartment, condominium, detached, loft, multiPlex, rowHouse, semiDetached, townhouse",
          ),
        size: z
          .number()
          .int()
          .min(0)
          .max(100_000)
          .optional()
          .describe("House size in square feet"),
        numberOfFloors: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("Number of floors"),
        numberOfRooms: z
          .number()
          .int()
          .min(0)
          .max(1_000)
          .optional()
          .describe("Number of rooms"),
        numberOfOccupants: z
          .number()
          .int()
          .min(0)
          .max(1_000)
          .optional()
          .describe("Number of occupants"),
        age: z
          .number()
          .int()
          .min(0)
          .max(1_000)
          .optional()
          .describe("Age of house in years"),
        windowEfficiency: z
          .number()
          .int()
          .min(1)
          .max(7)
          .optional()
          .describe("Window efficiency, 1-7"),
      }),
      outputSchema: mutationOutputSchema,
      annotations: mutationAnnotations,
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

      const updated = await api
        .getThermostats({
          selectionType: "thermostats",
          selectionMatch: id,
          includeHouseDetails: true,
        })
        .catch(() => []);
      const resultingDetails = updated[0]?.houseDetails ?? null;
      const confirmed =
        resultingDetails !== null &&
        Object.entries(houseDetails).every(
          ([key, value]) =>
            resultingDetails[key as keyof typeof resultingDetails] === value,
        );

      return structuredResult(
        mutationOutputSchema,
        {
          thermostatId: id,
          requestedChange: houseDetails,
          resultingState: {
            houseDetails: resultingDetails,
            verification: !resultingDetails
              ? "unavailable"
              : confirmed
                ? "confirmed"
                : "accepted",
          },
        },
        `House details updated: ${Object.keys(houseDetails).join(", ")}`,
      );
    },
  );
}
