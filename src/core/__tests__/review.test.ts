import { describe, expect, it } from 'vitest';

import { createCatalog } from '../catalog.js';
import { createImportPipeline, partitionDuplicates, type ImportPipelineDeps } from '../review.js';
import { CURRENT_SCHEMA_VERSION } from '../types.js';
import type {
  Measurement,
  MeasurementId,
  Metric,
  MetricId,
  ProfileData,
  ProfileId,
  ProposedMeasurement,
} from '../types.js';
import type { Catalog, ReviewItem } from '../contracts.js';

function emptyProfile(): ProfileData {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    profile: { id: 'p1' as ProfileId, name: 'Test', createdAt: '2026-07-21' },
    metrics: [],
    sources: [],
    measurements: [],
    settings: {},
  };
}

/** Deterministic injected deps: a counter for ids, a fixed clock. */
function testDeps(): ImportPipelineDeps {
  let n = 0;
  return {
    newId: () => `m${++n}` as MeasurementId,
    now: () => '2026-07-21T10:00',
    profileId: 'p1' as ProfileId,
  };
}

function pipelineWith(catalog: Catalog) {
  return createImportPipeline(catalog, testDeps());
}

describe('ImportPipeline.prepare', () => {
  const catalog = createCatalog(emptyProfile());
  const pipeline = pipelineWith(catalog);

  it('resolves a known alias to its metric id', () => {
    const proposals: ProposedMeasurement[] = [
      { metric: { unresolvedName: 'Glukóza' }, value: 5.4, unit: 'mmol/l', confidence: 'medium' },
    ];
    const [item] = pipeline.prepare(proposals, { catalog });
    expect(item.resolvedMetricId).toBe('builtin:glucose');
    expect(item.decision).toBe('pending');
    // unit spelling normalized to the UCUM code
    expect(item.proposed.unit).toBe('mmol/L');
  });

  it('leaves an unknown metric unresolved and pending', () => {
    const proposals: ProposedMeasurement[] = [
      {
        metric: { unresolvedName: 'Unobtanium level' },
        value: 1,
        confidence: 'low',
        rawText: 'Unobtanium level: 1',
      },
    ];
    const [item] = pipeline.prepare(proposals, { catalog });
    expect(item.resolvedMetricId).toBeUndefined();
    expect(item.decision).toBe('pending');
    // rawText survives normalization
    expect(item.proposed.rawText).toBe('Unobtanium level: 1');
    // metric stays an unresolved-name box, never guessed
    expect(item.proposed.metric).toEqual({ unresolvedName: 'Unobtanium level' });
  });

  it('accepts a proposal that already carries a resolved metric id', () => {
    const proposals: ProposedMeasurement[] = [
      { metric: 'builtin:hemoglobin' as MetricId, value: 145, unit: 'g/l', confidence: 'high' },
    ];
    const [item] = pipeline.prepare(proposals, { catalog });
    expect(item.resolvedMetricId).toBe('builtin:hemoglobin');
  });

  it('offers the candidate units canonical-first when the file stated none', () => {
    const proposals: ProposedMeasurement[] = [
      { metric: { unresolvedName: 'Folát' }, value: 12.3, confidence: 'medium' },
    ];
    const [item] = pipeline.prepare(proposals, { catalog });
    expect(item.resolvedMetricId).toBe('builtin:folate');
    // The catalog's canonical unit leads — a fact about the catalog, not a
    // preselection: nothing is chosen and the row stays blocked either way.
    expect(item.unitChoices?.[0]).toBe('nmol/L');
    expect(item.unitChoices).toHaveLength(3);
    expect(item.unitChoice).toBeUndefined();
  });

  it('asks for no unit when the candidates are the same unit under two names', () => {
    const proposals: ProposedMeasurement[] = [
      // Ferritin admits µg/L and ng/mL — 84 either way. A question whose answers
      // are identical is friction, not a safeguard.
      { metric: { unresolvedName: 'Ferritin' }, value: 84, confidence: 'medium' },
    ];
    const [item] = pipeline.prepare(proposals, { catalog });
    expect(item.resolvedMetricId).toBe('builtin:ferritin');
    expect(item.unitChoices).toBeUndefined();
  });

  it('asks for no unit when the value reads the same in every candidate unit', () => {
    const proposals: ProposedMeasurement[] = [
      // Normoblasts admit % and a bare ratio, which differ a hundredfold — but
      // not at zero. A question whose answers all store the same number is
      // friction, not a safeguard.
      { metric: { unresolvedName: 'Normoblasty' }, value: 0, confidence: 'medium' },
    ];
    const [item] = pipeline.prepare(proposals, { catalog });
    expect(item.resolvedMetricId).toBe('builtin:normoblasts');
    expect(item.unitChoices).toBeUndefined();
  });

  it('reads the unit off the number when only one of the candidates can hold it', () => {
    const proposals: ProposedMeasurement[] = [
      // Hematocrit is a volume fraction: 0,451 is a plausible L/L reading and an
      // impossible one in %, where it would mean a 0,45 % hematocrit. Nothing is
      // guessed — the other candidate is arithmetically out of the question, so
      // there is no choice left to offer.
      { metric: { unresolvedName: 'Hematokrit' }, value: 0.451, confidence: 'medium' },
    ];
    const [item] = pipeline.prepare(proposals, { catalog });
    expect(item.resolvedMetricId).toBe('builtin:hematocrit');
    expect(item.unitChoices).toBeUndefined();
    expect(item.proposed.unit).toBe('L/L');
    expect(item.unitDerived).toBe(true);
  });

  it('reads the same metric the other way round when the number is the percentage', () => {
    const proposals: ProposedMeasurement[] = [
      { metric: { unresolvedName: 'Hematokrit' }, value: 45.1, confidence: 'medium' },
    ];
    const [item] = pipeline.prepare(proposals, { catalog });
    expect(item.proposed.unit).toBe('%');
    expect(item.unitChoices).toBeUndefined();
  });

  it('still asks when the number is plausible in more than one candidate unit', () => {
    const proposals: ProposedMeasurement[] = [
      // A white-cell share has no narrow typical range — 0,551 is a believable
      // 55,1 % share AND a believable 0,551 % one, so the row stays blocked and
      // the user decides.
      { metric: { unresolvedName: 'Neutrofily' }, value: 0.551, confidence: 'medium' },
    ];
    const [item] = pipeline.prepare(proposals, { catalog });
    expect(item.resolvedMetricId).toBe('builtin:neutrophils');
    expect(item.unitChoices).toEqual(['%', '1']);
    expect(item.proposed.unit).toBeUndefined();
    expect(item.unitDerived).toBeUndefined();
  });

  it('asks rather than drops the row when no candidate unit fits the typical range', () => {
    // A hematocrit of 9 is outside the typical range in BOTH candidate units.
    // "None of them fits" is not evidence for any of them, so the closed set is
    // offered whole instead of the row being decided or discarded.
    const proposals: ProposedMeasurement[] = [
      { metric: { unresolvedName: 'Hematokrit' }, value: 9, confidence: 'medium' },
    ];
    const [item] = pipeline.prepare(proposals, { catalog });
    expect(item.unitChoices).toEqual(['L/L', '%']);
    expect(item.proposed.unit).toBeUndefined();
  });

  it('asks for no unit on a qualitative result, even on a multi-unit metric', () => {
    const proposals: ProposedMeasurement[] = [
      // A Czech dipstick reads "negativní" — there is no number for a unit to
      // apply to, so the row must not be held back asking for one.
      { metric: { unresolvedName: 'Bílkovina v moči' }, textValue: 'negativní', confidence: 'medium' },
    ];
    const [item] = pipeline.prepare(proposals, { catalog });
    expect(item.resolvedMetricId).toBe('builtin:urine-protein');
    expect(item.unitChoices).toBeUndefined();
  });

  it('treats a dangling metric id as unresolved (never guesses)', () => {
    const proposals: ProposedMeasurement[] = [
      { metric: 'builtin:does-not-exist' as MetricId, value: 1, confidence: 'high' },
    ];
    const [item] = pipeline.prepare(proposals, { catalog });
    expect(item.resolvedMetricId).toBeUndefined();
  });
});

describe('ImportPipeline.commit', () => {
  const catalog = createCatalog(emptyProfile());

  function prepared(): { pipeline: ReturnType<typeof createImportPipeline>; items: ReviewItem[] } {
    const pipeline = createImportPipeline(catalog, testDeps());
    const items = pipeline.prepare(
      [
        { metric: { unresolvedName: 'Glukóza' }, value: 5.4, unit: 'mmol/l', confidence: 'high', rawText: 'GLU 5,4' },
        { metric: { unresolvedName: 'Nope' }, value: 9, confidence: 'medium' },
        { metric: 'builtin:hemoglobin' as MetricId, value: 140, unit: 'g/L', confidence: 'medium' },
      ],
      { catalog },
    );
    return { pipeline, items };
  }

  it('stores only accepted + resolved items', () => {
    const { pipeline, items } = prepared();
    items[0].decision = 'accept'; // glucose, resolved
    items[1].decision = 'accept'; // unresolved -> nothing
    items[2].decision = 'reject'; // resolved but rejected -> nothing

    const measurements = pipeline.commit(items, { pluginId: 'test', sourceId: undefined });
    expect(measurements).toHaveLength(1);
    expect(measurements[0].metricId).toBe('builtin:glucose');
    expect(measurements[0].value).toBe(5.4);
    expect(measurements[0].unit).toBe('mmol/L');
  });

  it('produces nothing for all-pending items', () => {
    const { pipeline, items } = prepared();
    const measurements = pipeline.commit(items, { pluginId: 'test' });
    expect(measurements).toEqual([]);
  });

  it('commits a text (qualitative) proposal: textValue set, no numeric value or unit', () => {
    const textMetric: Metric = {
      id: 'custom:urine-protein' as MetricId,
      customName: 'Bílkovina v moči',
      aliases: [],
      category: 'lab',
      valueType: 'text',
      canonicalUnit: '',
      units: [],
    };
    const cat = createCatalog({ ...emptyProfile(), metrics: [textMetric] });
    const pipeline = createImportPipeline(cat, testDeps());
    const items = pipeline.prepare(
      [{ metric: 'custom:urine-protein' as MetricId, textValue: 'negativní', confidence: 'high' }],
      { catalog: cat },
    );
    items[0].decision = 'accept';
    const [m] = pipeline.commit(items, { pluginId: 'test' });
    expect(m.textValue).toBe('negativní');
    expect(m.value).toBeUndefined();
    expect(m.unit).toBe('');
  });

  it('takes ids, timestamps and profile id from injected deps', () => {
    const { pipeline, items } = prepared();
    items[0].decision = 'accept';
    const [m] = pipeline.commit(items, { pluginId: 'manual' });
    expect(m.id).toBe('m1');
    expect(m.profileId).toBe('p1');
    expect(m.createdAt).toBe('2026-07-21T10:00');
    expect(m.modifiedAt).toBe('2026-07-21T10:00');
    // no takenAt on the proposal -> derived from the clock
    expect(m.takenAt).toBe('2026-07-21T10:00');
    expect(m.timePrecision).toBe('datetime');
    expect(m.origin).toEqual({ pluginId: 'manual', rawText: 'GLU 5,4' });
  });

  it('maps high confidence to confirmed and lower confidence to needs-review', () => {
    const { pipeline, items } = prepared();
    items[0].decision = 'accept'; // high
    items[2].decision = 'accept'; // medium
    const out = pipeline.commit(items, { pluginId: 'test' });
    const glucose = out.find((m) => m.metricId === 'builtin:glucose');
    const hb = out.find((m) => m.metricId === 'builtin:hemoglobin');
    expect(glucose?.status).toBe('confirmed');
    expect(hb?.status).toBe('needs-review');
  });

  it('applies the source id from defaults', () => {
    const { pipeline, items } = prepared();
    items[0].decision = 'accept';
    const [m] = pipeline.commit(items, {
      pluginId: 'test',
      sourceId: 'src-1' as ProfileData['sources'][number]['id'],
    });
    expect(m.sourceId).toBe('src-1');
  });
});

describe('partitionDuplicates', () => {
  const base = (over: Partial<Measurement>): Measurement => ({
    id: 'x' as MeasurementId,
    profileId: 'p1' as ProfileId,
    metricId: 'builtin:creatinine' as MetricId,
    value: 91,
    unit: 'umol/L',
    takenAt: '2026-02-14T07:35',
    timePrecision: 'datetime',
    status: 'confirmed',
    origin: { pluginId: 'pdf' },
    createdAt: '2026-07-21T10:00',
    modifiedAt: '2026-07-21T10:00',
    ...over,
  });

  it('skips a reading identical to one already stored', () => {
    const existing = [base({ id: 'a' as MeasurementId })];
    const incoming = [base({ id: 'b' as MeasurementId })]; // same metric/instant/value/unit
    const { fresh, duplicates } = partitionDuplicates(existing, incoming);
    expect(fresh).toHaveLength(0);
    expect(duplicates).toHaveLength(1);
  });

  it('keeps a conflicting reading (same metric+instant, different value)', () => {
    const existing = [base({ id: 'a' as MeasurementId, value: 91 })];
    const incoming = [base({ id: 'b' as MeasurementId, value: 1 })];
    const { fresh, duplicates } = partitionDuplicates(existing, incoming);
    expect(fresh).toHaveLength(1);
    expect(duplicates).toHaveLength(0);
  });

  it('collapses duplicates within the incoming batch itself', () => {
    const incoming = [base({ id: 'a' as MeasurementId }), base({ id: 'b' as MeasurementId })];
    const { fresh, duplicates } = partitionDuplicates([], incoming);
    expect(fresh).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
  });

  it('treats a different unit or instant as a distinct reading', () => {
    const existing = [base({})];
    const { fresh } = partitionDuplicates(existing, [
      base({ id: 'u' as MeasurementId, unit: 'mg/dL' }),
      base({ id: 't' as MeasurementId, takenAt: '2026-02-15T07:35' }),
    ]);
    expect(fresh).toHaveLength(2);
  });

  it('dedupes qualitative (text) readings by their text value', () => {
    const neg = base({ metricId: 'builtin:urine-glucose' as MetricId, value: undefined, unit: '', textValue: 'negativní' });
    const { fresh, duplicates } = partitionDuplicates([neg], [
      base({ ...neg, id: 'b' as MeasurementId }),
      base({ ...neg, id: 'c' as MeasurementId, textValue: 'pozitivní' }),
    ]);
    expect(fresh).toHaveLength(1); // only the "pozitivní" one is new
    expect(duplicates).toHaveLength(1);
  });
});

// Contract shape sanity.
const _typecheck: ReviewItem = {
  proposed: { metric: { unresolvedName: 'x' }, value: 1, confidence: 'low' },
  decision: 'pending',
};
void _typecheck;
