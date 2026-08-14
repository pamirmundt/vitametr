import { describe, expect, it } from 'vitest';
import type { ChartPoint } from '../../chart-model';
import {
  buildSparklineSeries,
  clipToPeriod,
  DEFAULT_SPARKLINE_MODE,
  isRecentReading,
  showsSparkline,
} from '../sparkline-model';
import { createUnitsEngine } from '../../../core/units';
import type { Measurement, MeasurementId, Metric, MetricId, ProfileId } from '../../../core/types';

const DAY = 86_400_000;
const units = createUnitsEngine();

const glucose: Metric = {
  id: 'builtin:glucose' as MetricId,
  aliases: [],
  category: 'lab',
  valueType: 'number',
  nameKey: 'metric.glucose',
  canonicalUnit: 'mmol/L',
  units: ['mmol/L', 'mg/dL'],
  molarMass: 180.16,
  precision: { 'mmol/L': 1, 'mg/dL': 0 },
};

let seq = 0;

function reading(iso: string, value: number, extra: Partial<Measurement> = {}): Measurement {
  seq += 1;
  return {
    id: `meas-${seq}` as MeasurementId,
    profileId: 'p1' as ProfileId,
    metricId: glucose.id,
    takenAt: iso,
    timePrecision: 'date',
    value,
    unit: 'mmol/L',
    status: 'confirmed',
    origin: { pluginId: 'manual' },
    createdAt: iso,
    modifiedAt: iso,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// buildSparklineSeries
// ---------------------------------------------------------------------------

describe('buildSparklineSeries', () => {
  it('returns numeric readings ascending, in the display unit', () => {
    const { points } = buildSparklineSeries(
      glucose,
      [reading('2026-03-01T08:00:00Z', 5.5), reading('2025-03-01T08:00:00Z', 4.5)],
      units,
      'mmol/L',
    );
    expect(points.map((p) => p.value)).toEqual([4.5, 5.5]);
    expect(points[0].t).toBeLessThan(points[1].t);
  });

  it('drops readings with no value and unparseable instants', () => {
    const { points } = buildSparklineSeries(
      glucose,
      [
        reading('2026-03-01T08:00:00Z', 5.5),
        { ...reading('2026-04-01T08:00:00Z', 0), value: undefined, textValue: 'positive' },
        reading('not-a-date', 6.5),
      ],
      units,
      'mmol/L',
    );
    expect(points).toHaveLength(1);
  });

  it('reports a reading outside the range its OWN source stated, not just the last', () => {
    const withBounds = buildSparklineSeries(
      glucose,
      [
        reading('2024-03-01T08:00:00Z', 9.9, { refLow: 3.9, refHigh: 5.6 }),
        reading('2026-03-01T08:00:00Z', 5.0, { refLow: 3.9, refHigh: 5.6 }),
      ],
      units,
      'mmol/L',
    );
    expect(withBounds.everOutOfRange).toBe(true);

    const inside = buildSparklineSeries(
      glucose,
      [reading('2026-03-01T08:00:00Z', 5.0, { refLow: 3.9, refHigh: 5.6 })],
      units,
      'mmol/L',
    );
    expect(inside.everOutOfRange).toBe(false);
  });

  it('treats a reading with no stated bounds as never out of range', () => {
    const { points, everOutOfRange } = buildSparklineSeries(
      glucose,
      [reading('2026-03-01T08:00:00Z', 42)],
      units,
      'mmol/L',
    );
    expect(everOutOfRange).toBe(false);
    expect(points[0].refLow).toBeUndefined();
    expect(points[0].refHigh).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// clipToPeriod
// ---------------------------------------------------------------------------

describe('clipToPeriod', () => {
  const points: ChartPoint[] = [
    { t: 0, value: 1 },
    { t: 5 * DAY, value: 2 },
    { t: 10 * DAY, value: 3 },
  ];

  it('keeps everything when no period is given', () => {
    expect(clipToPeriod(points)).toEqual(points);
    expect(clipToPeriod(points, {})).toEqual(points);
  });

  it('keeps the readings inside the period, bounds included', () => {
    expect(clipToPeriod(points, { from: 5 * DAY }).map((p) => p.value)).toEqual([2, 3]);
    expect(clipToPeriod(points, { to: 5 * DAY }).map((p) => p.value)).toEqual([1, 2]);
    expect(clipToPeriod(points, { from: 1, to: 9 * DAY }).map((p) => p.value)).toEqual([2]);
  });

  it('returns nothing when the whole series falls outside', () => {
    expect(clipToPeriod(points, { from: 20 * DAY })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// showsSparkline
// ---------------------------------------------------------------------------

describe('showsSparkline', () => {
  const plain = { numeric: true, count: 3, watched: false, everOutOfRange: false };

  it('draws nothing at all in hidden mode', () => {
    expect(showsSparkline('hidden', { ...plain, watched: true, everOutOfRange: true })).toBe(false);
  });

  it('needs a numeric row with at least one reading', () => {
    expect(showsSparkline('all', { ...plain, numeric: false })).toBe(false);
    expect(showsSparkline('all', { ...plain, count: 0 })).toBe(false);
    expect(showsSparkline('all', { ...plain, count: 1 })).toBe(true);
  });

  it('in the default mode draws only the rows worth a second look', () => {
    expect(DEFAULT_SPARKLINE_MODE).toBe('outliers');
    expect(showsSparkline('outliers', plain)).toBe(false);
    expect(showsSparkline('outliers', { ...plain, watched: true })).toBe(true);
    expect(showsSparkline('outliers', { ...plain, everOutOfRange: true })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isRecentReading
// ---------------------------------------------------------------------------

describe('isRecentReading', () => {
  const now = Date.parse('2026-08-14T12:00:00Z');

  it('accepts the last week, and a reading dated slightly ahead', () => {
    expect(isRecentReading(now, now)).toBe(true);
    expect(isRecentReading(now - 6 * DAY, now)).toBe(true);
    expect(isRecentReading(now + DAY / 2, now)).toBe(true);
  });

  it('rejects anything older than a week or far in the future', () => {
    expect(isRecentReading(now - 8 * DAY, now)).toBe(false);
    expect(isRecentReading(now + 2 * DAY, now)).toBe(false);
  });
});
