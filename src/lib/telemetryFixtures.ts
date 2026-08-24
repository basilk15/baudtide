import type { TelemetryFormat } from './telemetry';

export type TelemetryFixtureSignal = Readonly<{
  key: string;
  unit?: string;
  values: readonly number[];
}>;

export type TelemetryFormatFixture = Readonly<{
  id: string;
  label: string;
  format: TelemetryFormat;
  /** Complete serial lines, without their line terminator. */
  lines: readonly string[];
  signals: readonly TelemetryFixtureSignal[];
}>;

const firstSample = {
  temperature: 20.94,
  humidity: 43.05,
  voltage: 3.315,
  rpm: 995,
};

const secondSample = {
  temperature: 20.78,
  humidity: 41.98,
  voltage: 3.293,
  rpm: 1033.5,
};

const expectedPlainSignals: readonly TelemetryFixtureSignal[] = [
  { key: 'temperature', values: [firstSample.temperature, secondSample.temperature] },
  { key: 'humidity', values: [firstSample.humidity, secondSample.humidity] },
  { key: 'voltage', values: [firstSample.voltage, secondSample.voltage] },
  { key: 'rpm', values: [firstSample.rpm, secondSample.rpm] },
];

const expectedUnitSignals: readonly TelemetryFixtureSignal[] = [
  { key: 'temperature', unit: '°C', values: [firstSample.temperature, secondSample.temperature] },
  { key: 'humidity', unit: '%', values: [firstSample.humidity, secondSample.humidity] },
  { key: 'voltage', unit: 'V', values: [firstSample.voltage, secondSample.voltage] },
  { key: 'rpm', unit: 'rpm', values: [firstSample.rpm, secondSample.rpm] },
];

const jsonLine = (sample: typeof firstSample) => JSON.stringify(sample);

export const TELEMETRY_FORMAT_FIXTURES: readonly TelemetryFormatFixture[] = [
  {
    id: 'json-object',
    label: 'JSON object with numeric values',
    format: 'json',
    lines: [jsonLine(firstSample), jsonLine(secondSample)],
    signals: expectedPlainSignals,
  },
  {
    id: 'json-prefixed',
    label: 'JSON object with device prefix',
    format: 'json',
    lines: [
      '[sensor] 11:25:59.085 ' + jsonLine(firstSample),
      '[sensor] 11:25:59.437 ' + jsonLine(secondSample),
    ],
    signals: expectedPlainSignals,
  },
  {
    id: 'json-string-units',
    label: 'JSON strings containing numeric values and units',
    format: 'json',
    lines: [
      JSON.stringify({
        temperature: '20.94 °C',
        humidity: '43.05 %',
        voltage: '3.315 V',
        rpm: '995 rpm',
      }),
      JSON.stringify({
        temperature: '20.78 °C',
        humidity: '41.98 %',
        voltage: '3.293 V',
        rpm: '1033.5 rpm',
      }),
    ],
    signals: expectedUnitSignals,
  },
  {
    id: 'json-measurements',
    label: 'JSON typed value/unit measurements',
    format: 'json',
    lines: [
      JSON.stringify({
        temperature: { value: firstSample.temperature, unit: '°C' },
        humidity: { value: String(firstSample.humidity), unit: '%' },
        voltage: { value: firstSample.voltage, units: 'V' },
        rpm: { reading: firstSample.rpm, unit: 'rpm' },
      }),
      JSON.stringify({
        temperature: { value: secondSample.temperature, unit: '°C' },
        humidity: { value: String(secondSample.humidity), unit: '%' },
        voltage: { value: secondSample.voltage, units: 'V' },
        rpm: { reading: secondSample.rpm, unit: 'rpm' },
      }),
    ],
    signals: expectedUnitSignals,
  },
  {
    id: 'json-array',
    label: 'JSON array of records',
    format: 'json',
    lines: [
      JSON.stringify([firstSample, secondSample]),
      JSON.stringify([{ ...firstSample, temperature: 21.1 }, { ...secondSample, temperature: 20.6 }]),
    ],
    signals: [
      { key: 'temperature', values: [firstSample.temperature, secondSample.temperature, 21.1, 20.6] },
      { key: 'humidity', values: [firstSample.humidity, secondSample.humidity, firstSample.humidity, secondSample.humidity] },
      { key: 'voltage', values: [firstSample.voltage, secondSample.voltage, firstSample.voltage, secondSample.voltage] },
      { key: 'rpm', values: [firstSample.rpm, secondSample.rpm, firstSample.rpm, secondSample.rpm] },
    ],
  },
  {
    id: 'json-data-batch',
    label: 'JSON data batch',
    format: 'json',
    lines: [
      JSON.stringify({ data: [firstSample, secondSample] }),
      JSON.stringify({ readings: [{ ...firstSample, humidity: 42.1 }, { ...secondSample, humidity: 40.9 }] }),
    ],
    signals: [
      { key: 'temperature', values: [firstSample.temperature, secondSample.temperature, firstSample.temperature, secondSample.temperature] },
      { key: 'humidity', values: [firstSample.humidity, secondSample.humidity, 42.1, 40.9] },
      { key: 'voltage', values: [firstSample.voltage, secondSample.voltage, firstSample.voltage, secondSample.voltage] },
      { key: 'rpm', values: [firstSample.rpm, secondSample.rpm, firstSample.rpm, secondSample.rpm] },
    ],
  },
  {
    id: 'key-value-pairs',
    label: 'Key/value pairs with mixed separators',
    format: 'pairs',
    lines: [
      'temperature=20.94 °C; humidity:43.05 % | voltage=3.315 V rpm:995 rpm',
      'temperature=20.78 °C; humidity:41.98 % | voltage=3.293 V rpm:1033.5 rpm',
    ],
    signals: expectedUnitSignals,
  },
  {
    id: 'csv-header',
    label: 'Header-based CSV',
    format: 'csv',
    lines: [
      'temperature (°C),humidity (%),voltage (V),rpm (rpm)',
      '20.94,43.05,3.315,995',
      '20.78,41.98,3.293,1033.5',
    ],
    signals: expectedUnitSignals,
  },
  {
    id: 'tsv-header',
    label: 'Header-based TSV',
    format: 'tsv',
    lines: [
      'temperature [°C]\thumidity [%]\tvoltage [V]\trpm [rpm]',
      '20.94\t43.05\t3.315\t995',
      '20.78\t41.98\t3.293\t1033.5',
    ],
    signals: expectedUnitSignals,
  },
];
