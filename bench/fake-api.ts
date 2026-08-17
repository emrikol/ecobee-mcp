import { EcobeeApiClient } from "../src/ecobee/api.js";
import type { EcobeeAuth } from "../src/ecobee/auth.js";

const thermostat = {
  identifier: "benchmark-thermostat",
  name: "Benchmark",
  modelNumber: "fixture",
  thermostatTime: "2026-08-17 12:00:00",
  runtime: {
    connected: true,
    actualTemperature: 710,
    actualHumidity: 42,
    desiredHeat: 680,
    desiredCool: 760,
  },
  settings: { hvacMode: "auto", drAccept: "always" },
  program: {
    currentClimateRef: "home",
    schedule: Array.from({ length: 7 }, () => Array(48).fill("home")),
    climates: [
      {
        name: "Home",
        climateRef: "home",
        type: "program",
        isOccupied: true,
        coolFan: "auto",
        heatFan: "auto",
        coolTemp: 760,
        heatTemp: 680,
      },
    ],
  },
  events: [],
  alerts: [],
  remoteSensors: [
    {
      id: "sensor-1",
      name: "Living Room",
      type: "ecobee3_remote_sensor",
      inUse: true,
      capability: [
        { type: "temperature", value: "711" },
        { type: "humidity", value: "42" },
        { type: "occupancy", value: "true" },
      ],
    },
  ],
  weather: {
    timestamp: "2026-08-17 12:00:00",
    weatherStation: "FIXTURE",
    forecasts: [],
  },
  equipmentStatus: "",
};

const runtimeColumns = [
  "auxHeat1",
  "auxHeat2",
  "auxHeat3",
  "compCool1",
  "compCool2",
  "compHeat1",
  "compHeat2",
  "fan",
  "humidifier",
  "dehumidifier",
  "economizer",
  "ventilator",
  "zoneAveTemp",
  "zoneCoolTemp",
  "zoneHeatTemp",
  "zoneHumidity",
  "outdoorTemp",
  "outdoorHumidity",
  "hvacMode",
  "zoneClimate",
];

const runtimeRows = Array.from({ length: 288 }, (_, interval) => {
  const hour = Math.floor(interval / 12)
    .toString()
    .padStart(2, "0");
  const minute = ((interval % 12) * 5).toString().padStart(2, "0");
  const values = runtimeColumns.map((column, index) => {
    if (column === "hvacMode") return "auto";
    if (column === "zoneClimate") return "home";
    return index < 12 ? String((interval + index) % 300) : String(700 + index);
  });
  return ["2026-08-01", `${hour}:${minute}:00`, ...values].join(",");
});

export function createBenchmarkApi(): EcobeeApiClient {
  return {
    withRequestSignal: async <T>(
      signal: AbortSignal,
      operation: () => Promise<T>,
    ) => {
      if (signal.aborted) {
        const error = new Error("Request cancelled.");
        error.name = "AbortError";
        throw error;
      }
      return operation();
    },
    getThermostats: async () => [thermostat],
    getRuntimeReport: async () => ({
      startDate: "2026-08-01",
      startInterval: 0,
      endDate: "2026-08-01",
      endInterval: 287,
      columns: runtimeColumns.join(","),
      reportList: [
        {
          thermostatIdentifier: thermostat.identifier,
          rowCount: runtimeRows.length,
          rowList: runtimeRows,
        },
      ],
      sensorList: [],
      status: { code: 0, message: "" },
    }),
  } as unknown as EcobeeApiClient;
}

export function createTransportBenchmarkApi(): EcobeeApiClient {
  const payload = new TextEncoder().encode(
    JSON.stringify({
      thermostatList: [
        {
          identifier: "transport-fixture",
          name: "x".repeat(512 * 1024),
        },
      ],
      status: { code: 0, message: "" },
    }),
  );
  const auth = {
    getAccessToken: async () => "benchmark-token",
  } as EcobeeAuth;
  return new EcobeeApiClient(auth, {
    baseUrl: "https://fixture.invalid",
    maxResponseBytes: 1024 * 1024,
    fetch: async () => {
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= payload.length) {
            controller.close();
            return;
          }
          const end = Math.min(offset + 1_024, payload.length);
          controller.enqueue(payload.slice(offset, end));
          offset = end;
        },
      });
      return new Response(body, {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    },
  });
}
