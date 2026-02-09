/* v8 ignore start -- Integration test: tool registration barrel.
   Test that registerAllTools registers all 24 tools on the MCP server.
   Verify via MCP client session tools/list that every tool is discoverable. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EcobeeApiClient } from "../ecobee/api.js";
import type { EcobeeCache } from "../ecobee/cache.js";
import { registerListThermostats } from "./list-thermostats.js";
import { registerGetThermostatStatus } from "./status.js";
import { registerGetSensors } from "./sensors.js";
import { registerGetWeather } from "./weather.js";
import { registerGetSchedule } from "./schedule.js";
import { registerListVacations } from "./list-vacations.js";
import { registerGetAlerts, registerAcknowledgeAlert } from "./alerts.js";
import { registerGetRuntimeReport } from "./runtime-report.js";
import { registerGetExtendedRuntime } from "./extended-runtime.js";
import { registerGetDemandResponse } from "./demand-response.js";
import { registerGetUtilityInfo } from "./utility-info.js";
import { registerGetTechnicianInfo } from "./technician-info.js";
import {
  registerGetHouseDetails,
  registerUpdateHouseDetails,
} from "./house-details.js";
import { registerListGroups, registerManageGroup } from "./groups.js";
import { registerSetTemperature } from "./set-temperature.js";
import { registerSetMode } from "./set-mode.js";
import { registerSetHold } from "./set-hold.js";
import { registerResumeSchedule } from "./resume-schedule.js";
import { registerSetVacation } from "./set-vacation.js";
import { registerSendMessage } from "./send-message.js";
import { registerUpdateComfortProfile } from "./update-comfort-profile.js";

/**
 * Register all built-in MCP tools.
 */
export function registerAllTools(
  server: McpServer,
  api: EcobeeApiClient,
  cache: EcobeeCache,
): void {
  // Read tools
  registerListThermostats(server, api, cache);
  registerGetThermostatStatus(server, api, cache);
  registerGetSensors(server, api, cache);
  registerGetWeather(server, api, cache);
  registerGetSchedule(server, api, cache);
  registerListVacations(server, api, cache);
  registerGetAlerts(server, api, cache);
  registerGetRuntimeReport(server, api, cache);
  registerGetExtendedRuntime(server, api, cache);
  registerGetDemandResponse(server, api, cache);
  registerGetUtilityInfo(server, api, cache);
  registerGetTechnicianInfo(server, api, cache);
  registerGetHouseDetails(server, api, cache);
  registerListGroups(server, api, cache);

  // Write tools
  registerSetTemperature(server, api, cache);
  registerSetMode(server, api, cache);
  registerSetHold(server, api, cache);
  registerResumeSchedule(server, api, cache);
  registerSetVacation(server, api, cache);
  registerAcknowledgeAlert(server, api, cache);
  registerSendMessage(server, api, cache);
  registerUpdateComfortProfile(server, api, cache);
  registerUpdateHouseDetails(server, api, cache);
  registerManageGroup(server, api, cache);
}
