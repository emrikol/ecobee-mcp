/**
 * Ecobee API TypeScript interfaces.
 * See: https://www.ecobee.com/home/developer/api/documentation/v1/objects
 */

// --- Auth ---

export interface EcobeeCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp (ms)
  apiKey: string;
}

export interface EcobeeTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number; // seconds
  scope: string;
}

// --- Thermostat ---

export interface ThermostatSummary {
  revisionList: string[];
  thermostatCount: number;
  statusList: string[];
}

export interface Thermostat {
  identifier: string;
  name: string;
  thermostatRev: string;
  isRegistered: boolean;
  modelNumber: string;
  brand: string;
  features: string;
  lastModified: string;
  thermostatTime: string;
  utcTime: string;
  runtime?: Runtime;
  extendedRuntime?: ExtendedRuntime;
  settings?: Settings;
  program?: Program;
  events?: Event[];
  alerts?: Alert[];
  weather?: Weather;
  remoteSensors?: RemoteSensor[];
  houseDetails?: HouseDetails;
  technician?: Technician;
  utility?: Utility;
  equipmentStatus?: string;
}

export interface Runtime {
  runtimeRev: string;
  connected: boolean;
  firstConnected: string;
  connectDateTime: string;
  disconnectDateTime: string;
  lastModified: string;
  lastStatusModified: string;
  runtimeDate: string;
  runtimeInterval: number;
  actualTemperature: number; // 1/10 degree F
  actualHumidity: number;
  rawTemperature: number;
  showIconMode: number;
  desiredHeat: number; // 1/10 degree F
  desiredCool: number; // 1/10 degree F
  desiredHumidity: number;
  desiredDehumidity: number;
  desiredFanMode: string;
  desiredHeatRange: number[];
  desiredCoolRange: number[];
}

export interface ExtendedRuntime {
  lastReadingTimestamp: string;
  runtimeDate: string;
  runtimeInterval: number;
  actualTemperature: number[];
  actualHumidity: number[];
  desiredHeat: number[];
  desiredCool: number[];
  desiredHumidity: number[];
  desiredDehumidity: number[];
  dmOffset: number[];
  hvacMode: string[];
  heatPump1: number[];
  heatPump2: number[];
  auxHeat1: number[];
  auxHeat2: number[];
  auxHeat3: number[];
  cool1: number[];
  cool2: number[];
  fan: number[];
  humidifier: number[];
  dehumidifier: number[];
  economizer: number[];
  ventilator: number[];
  currentElectricityBill: number;
  projectedElectricityBill: number;
}

export interface Settings {
  hvacMode: string; // heat, cool, auto, off, auxHeatOnly
  lastServiceDate: string;
  serviceRemindMe: boolean;
  monthsBetweenService: number;
  remindMeDate: string;
  vent: string;
  ventilatorMinOnTime: number;
  serviceRemindTechnician: boolean;
  eiLocation: string;
  coldTempAlert: number;
  coldTempAlertEnabled: boolean;
  hotTempAlert: number;
  hotTempAlertEnabled: boolean;
  coolStages: number;
  heatStages: number;
  maxSetBack: number;
  maxSetForward: number;
  quickSaveSetBack: number;
  quickSaveSetForward: number;
  hasHeatPump: boolean;
  hasForcedAir: boolean;
  hasBoiler: boolean;
  hasHumidifier: boolean;
  hasErv: boolean;
  hasHrv: boolean;
  condensationAvoid: boolean;
  useCelsius: boolean;
  useTimeFormat12: boolean;
  locale: string;
  humidity: string;
  humidifierMode: string;
  backlightOnIntensity: number;
  backlightSleepIntensity: number;
  backlightOffTime: number;
  soundTickVolume: number;
  soundAlertVolume: number;
  compressorProtectionMinTime: number;
  compressorProtectionMinTemp: number;
  stage1HeatingDifferentialTemp: number;
  stage1CoolingDifferentialTemp: number;
  stage1HeatingDissipationTime: number;
  stage1CoolingDissipationTime: number;
  heatPumpReversalOnCool: boolean;
  dehumidifierMode: string;
  dehumidifierLevel: number;
  dehumidifyWithAC: boolean;
  dehumidifyOvercoolOffset: number;
  autoHeatCoolFeatureEnabled: boolean;
  wifiOfflineAlert: boolean;
  heatMinTemp: number;
  heatMaxTemp: number;
  coolMinTemp: number;
  coolMaxTemp: number;
  heatRangeHigh: number;
  heatRangeLow: number;
  coolRangeHigh: number;
  coolRangeLow: number;
  userAccessCode: string;
  userAccessSetting: number;
  auxRuntimeAlert: number;
  auxOutdoorTempAlert: number;
  auxMaxOutdoorTemp: number;
  auxRuntimeAlertNotify: boolean;
  auxOutdoorTempAlertNotify: boolean;
  auxRuntimeAlertNotifyTechnician: boolean;
  auxOutdoorTempAlertNotifyTechnician: boolean;
  disablePreHeating: boolean;
  disablePreCooling: boolean;
  installerCodeRequired: boolean;
  drAccept: string;
  isRentalProperty: boolean;
  useZoneController: boolean;
  randomStartDelayCool: number;
  randomStartDelayHeat: number;
  humidityHighAlert: number;
  humidityLowAlert: number;
  disableHeatPumpAlerts: boolean;
  disableAlertsOnIdt: boolean;
  humidityAlertNotify: boolean;
  humidityAlertNotifyTechnician: boolean;
  monthlyElectricityBillLimit: number;
  enableElectricityBillAlert: boolean;
  enableProjectedElectricityBillAlert: boolean;
  electricityBillingDayOfMonth: number;
  electricityBillCycleMonths: number;
  electricityBillStartMonth: number;
  ventilatorMinOnTimeHome: number;
  ventilatorMinOnTimeAway: number;
  backlightOffDuringSleep: boolean;
  autoAway: boolean;
  smartCirculation: boolean;
  followMeComfort: boolean;
  ventilatorType: string;
  isVentilatorTimerOn: boolean;
  ventilatorOffDateTime: string;
  hasUVFilter: boolean;
  coolingLockout: boolean;
  ventilatorFreeCooling: boolean;
  dehumidifyWhenHeating: boolean;
  ventilatorDehumidify: boolean;
  groupRef: string;
  groupName: string;
  groupSetting: number;
}

export interface Program {
  schedule: string[][]; // [day][period] climate ref
  climates: Climate[];
  currentClimateRef: string;
}

export interface Climate {
  name: string;
  climateRef: string;
  isOccupied: boolean;
  isOptimized: boolean;
  coolFan: string;
  heatFan: string;
  vent: string;
  ventilatorMinOnTime: number;
  owner: string;
  type: string;
  colour: number;
  coolTemp: number; // 1/10 degree F
  heatTemp: number; // 1/10 degree F
}

export interface Event {
  type: string;
  name: string;
  running: boolean;
  startDate: string; // YYYY-MM-DD
  startTime: string; // HH:mm:ss
  endDate: string;
  endTime: string;
  isOccupied: boolean;
  isCoolOff: boolean;
  isHeatOff: boolean;
  coolHoldTemp: number; // 1/10 degree F
  heatHoldTemp: number; // 1/10 degree F
  fan: string;
  vent: string;
  ventilatorMinOnTime: number;
  isOptional: boolean;
  isTemperatureRelative: boolean;
  isTemperatureAbsolute: boolean;
  dutyCyclePercentage: number;
  fanMinOnTime: number;
  occupiedSensorActive: boolean;
  unoccupiedSensorActive: boolean;
  drRampUpTemp: number;
  drRampUpTime: number;
  linkRef: string;
  holdClimateRef: string;
}

// --- Weather ---

export interface Weather {
  timestamp: string;
  weatherStation: string;
  forecasts: WeatherForecast[];
}

export interface WeatherForecast {
  weatherSymbol: number;
  dateTime: string;
  condition: string;
  temperature: number; // 1/10 degree F
  pressure: number;
  relativeHumidity: number;
  dewpoint: number;
  visibility: number;
  windSpeed: number;
  windGust: number;
  windDirection: string;
  windBearing: number;
  pop: number; // probability of precipitation
  tempHigh: number;
  tempLow: number;
  sky: number;
}

// --- Sensors ---

export interface RemoteSensor {
  id: string;
  name: string;
  type: string;
  code: string;
  inUse: boolean;
  capability: SensorCapability[];
}

export interface SensorCapability {
  id: string;
  type: string; // temperature, humidity, occupancy
  value: string;
}

// --- House Details ---

export interface HouseDetails {
  style: string; // other, apartment, condominium, detached, loft, multiPlex, rowHouse, semiDetached, townhouse
  size: number; // square feet
  numberOfFloors: number;
  numberOfRooms: number;
  numberOfOccupants: number;
  age: number; // years
  windowEfficiency: number; // 1-7
}

// --- Technician ---

export interface Technician {
  contractorRef: string;
  name: string;
  phone: string;
  streetAddress: string;
  city: string;
  provinceState: string;
  country: string;
  postalCode: string;
  email: string;
  web: string;
}

// --- Utility ---

export interface Utility {
  name: string;
  phone: string;
  email: string;
  web: string;
}

// --- Groups ---

export interface Group {
  groupRef: string;
  groupName: string;
  synchronizeAlerts: boolean;
  synchronizeSystemMode: boolean;
  synchronizeSchedule: boolean;
  synchronizeQuickSave: boolean;
  synchronizeReminders: boolean;
  synchronizeContractorInfo: boolean;
  synchronizeUserPreferences: boolean;
  synchronizeUtilityInfo: boolean;
  synchronizeLocation: boolean;
  synchronizeReset: boolean;
  synchronizeVacation: boolean;
  thermostats: string[]; // thermostat identifiers
}

export interface GroupResponse {
  groups: Group[];
  status: { code: number; message: string };
}

// --- Alerts ---

export interface Alert {
  acknowledgeRef: string;
  date: string;
  time: string;
  severity: string; // low, medium, high
  text: string;
  alertNumber: number;
  alertType: string; // alert, demandResponse, emergency, message, pricing
  isOperatorAlert: boolean;
  reminder: string;
  showIdt: boolean;
  showWeb: boolean;
  sendEmail: boolean;
  acknowledgement: string; // accept, decline, defer, unacknowledged
  remindMeLater: boolean;
  thermostatIdentifier: string;
  notificationType: string; // hvac, furnaceFilter, temp, etc.
}

// --- Runtime Report ---

export interface RuntimeReportRequest {
  selection: ThermostatSelection;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  startInterval?: number; // 0-287
  endInterval?: number; // 0-287
  columns: string; // CSV of column names
  includeSensors?: boolean;
}

export interface RuntimeReportResponse {
  startDate: string;
  startInterval: number;
  endDate: string;
  endInterval: number;
  columns: string;
  reportList: RuntimeReport[];
  sensorList: unknown[];
  status: { code: number; message: string };
}

export interface RuntimeReport {
  thermostatIdentifier: string;
  rowCount: number;
  rowList: string[]; // CSV rows: "date,time,col1,col2,..."
}

// --- API Request/Response ---

export interface EcobeeApiResponse<T = unknown> {
  status: {
    code: number;
    message: string;
  };
  page?: {
    page: number;
    totalPages: number;
    pageSize: number;
    total: number;
  };
  thermostatList?: Thermostat[];
  // Generic payload for other endpoints
  [key: string]: T | unknown;
}

export interface ThermostatSelection {
  selectionType: "registered" | "thermostats";
  selectionMatch: string; // empty for registered, CSV thermostat IDs
  includeRuntime?: boolean;
  includeExtendedRuntime?: boolean;
  includeSettings?: boolean;
  includeProgram?: boolean;
  includeEvents?: boolean;
  includeWeather?: boolean;
  includeSensors?: boolean;
  includeEquipmentStatus?: boolean;
  includeAlerts?: boolean;
  includeHouseDetails?: boolean;
  includeTechnician?: boolean;
  includeUtility?: boolean;
}

export interface ThermostatUpdateBody {
  selection: ThermostatSelection;
  functions?: ThermostatFunction[];
  thermostat?: Partial<Thermostat>;
}

export interface ThermostatFunction {
  type: string;
  params: Record<string, unknown>;
}

// --- Temperature helpers ---

/** Convert Ecobee 1/10-degree F to degrees F */
export function fromEcobeeTemp(ecobeeTemp: number): number {
  return ecobeeTemp / 10;
}

/** Convert degrees F to Ecobee 1/10-degree F */
export function toEcobeeTemp(degreesF: number): number {
  return Math.round(degreesF * 10);
}
