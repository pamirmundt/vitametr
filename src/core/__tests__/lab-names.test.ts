import { describe, expect, it } from 'vitest';

import { isDistinctSpecimen, splitAnalyteName } from '../lab-names.js';

describe('splitAnalyteName', () => {
  it('reads the tissue-system prefix and drops it from the name', () => {
    expect(splitAnalyteName('S_Kreatinin')).toEqual({ name: 'Kreatinin', specimen: 'serum' });
    expect(splitAnalyteName('P_Glukóza')).toEqual({ name: 'Glukóza', specimen: 'plasma' });
    expect(splitAnalyteName('B_HbA1c')).toEqual({ name: 'HbA1c', specimen: 'blood' });
    expect(splitAnalyteName('U_Glukóza')).toEqual({ name: 'Glukóza', specimen: 'urine' });
    expect(splitAnalyteName('dU_Kreatinin')).toEqual({ name: 'Kreatinin', specimen: 'urine-24h' });
    expect(splitAnalyteName('F_Okultní krvácení')).toEqual({
      name: 'Okultní krvácení',
      specimen: 'stool',
    });
    expect(splitAnalyteName('C_CKD-EPI 2021')).toEqual({
      name: 'CKD-EPI 2021',
      specimen: 'calculated',
    });
  });

  it('drops the code columns printed to the left of the prefixed name', () => {
    expect(splitAnalyteName('HAD AM S_Kreatinin')).toEqual({
      name: 'Kreatinin',
      specimen: 'serum',
    });
    expect(splitAnalyteName('VZR B_Nezralé granulocyty abs.počet')).toEqual({
      name: 'Nezralé granulocyty abs.počet',
      specimen: 'blood',
    });
  });

  it('leaves an unprefixed name completely alone', () => {
    // The danger case: "HDL" must never be mistaken for a code column, or the
    // row would resolve onto plain cholesterol.
    expect(splitAnalyteName('HDL cholesterol')).toEqual({ name: 'HDL cholesterol' });
    expect(splitAnalyteName('Kyselina močová')).toEqual({ name: 'Kyselina močová' });
    expect(splitAnalyteName('Glykovaný hemoglobin (HbA1c)')).toEqual({
      name: 'Glykovaný hemoglobin (HbA1c)',
    });
  });

  it('ignores an underscore that is not a known tissue-system prefix', () => {
    expect(splitAnalyteName('HbA1c_IFCC')).toEqual({ name: 'HbA1c_IFCC' });
    expect(splitAnalyteName('X_Něco')).toEqual({ name: 'X_Něco' });
  });

  it('does not treat a bare prefix token as a name', () => {
    expect(splitAnalyteName('S_')).toEqual({ name: 'S_' });
  });

  it('marks only non-blood specimens as distinct', () => {
    expect(isDistinctSpecimen('urine')).toBe(true);
    expect(isDistinctSpecimen('urine-24h')).toBe(true);
    expect(isDistinctSpecimen('stool')).toBe(true);
    expect(isDistinctSpecimen('serum')).toBe(false);
    expect(isDistinctSpecimen('calculated')).toBe(false);
    expect(isDistinctSpecimen(undefined)).toBe(false);
  });
});
