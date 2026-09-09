/**
 * Dev-only: render a SYNTHETIC Czech lab result sheet to a PDF fixture with a
 * real text layer, so the PDF import parser can be tested without any real
 * patient data. Layout follows the 5-column structure described in public
 * Czech lab manuals (name, result, flag, unit, reference range) — no lab
 * branding or logos are reproduced.
 *
 * Run: node scripts/gen-lab-pdf.mjs
 */

import { chromium } from '@playwright/test';
import { mkdirSync } from 'fs';

const HTML = `<!doctype html><html lang="cs"><head><meta charset="utf-8">
<style>
  body { font-family: Arial, sans-serif; font-size: 11px; color: #000; padding: 24px; }
  h1 { font-size: 15px; margin: 0 0 2px; }
  .meta { font-size: 10px; color: #333; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 3px 6px; border-bottom: 1px solid #ccc; }
  th { border-bottom: 2px solid #000; }
  .num { text-align: right; }
  .flag { color: #b00; font-weight: bold; }
</style></head><body>
  <h1>Výsledkový list — biochemie</h1>
  <div class="meta">Pacient: Testovací Vzor (nar. 1980) · Odběr: 10.02.2023 07:45 · Vzorek: sérum</div>
  <table>
    <tr><th>Vyšetření</th><th class="num">Výsledek</th><th>Hodn.</th><th>Jednotka</th><th>Referenční meze</th></tr>
    <tr><td>Glukóza</td><td class="num">5,4</td><td></td><td>mmol/l</td><td>3,9 - 5,6</td></tr>
    <tr><td>Cholesterol celkový</td><td class="num">5,9</td><td class="flag">H</td><td>mmol/l</td><td>0,0 - 5,0</td></tr>
    <tr><td>LDL cholesterol</td><td class="num">3,2</td><td class="flag">H</td><td>mmol/l</td><td>0,0 - 3,0</td></tr>
    <tr><td>HDL cholesterol</td><td class="num">1,4</td><td></td><td>mmol/l</td><td>1,0 - 2,1</td></tr>
    <tr><td>Triglyceridy</td><td class="num">1,8</td><td></td><td>mmol/l</td><td>0,0 - 1,7</td></tr>
    <tr><td>Kreatinin</td><td class="num">78</td><td></td><td>umol/l</td><td>64 - 104</td></tr>
    <tr><td>Kyselina močová</td><td class="num">320</td><td></td><td>umol/l</td><td>202 - 417</td></tr>
    <tr><td>ALT</td><td class="num">0,45</td><td></td><td>ukat/l</td><td>0,10 - 0,78</td></tr>
    <tr><td>TSH</td><td class="num">2,10</td><td></td><td>mIU/l</td><td>0,27 - 4,20</td></tr>
    <tr><td>Vitamin D</td><td class="num">62</td><td class="flag">L</td><td>nmol/l</td><td>75 - 200</td></tr>
  </table>
</body></html>`;

// A second layout: a named provider in the header and varied reference-range
// styles (one-sided "< X", Czech "do X", a censored value "< 0,10").
const HTML_SYNLAB = `<!doctype html><html lang="cs"><head><meta charset="utf-8">
<style>
  body { font-family: Arial, sans-serif; font-size: 11px; color: #000; padding: 24px; }
  h1 { font-size: 15px; margin: 0 0 2px; }
  .prov { font-size: 12px; font-weight: bold; margin-bottom: 2px; }
  .meta { font-size: 10px; color: #333; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 3px 6px; border-bottom: 1px solid #ccc; }
  th { border-bottom: 2px solid #000; }
  .num { text-align: right; }
</style></head><body>
  <div class="prov">SYNLAB czech s.r.o.</div>
  <h1>Laboratorní výsledky</h1>
  <div class="meta">Pacient: Testovací Vzor · Datum odběru: 14.08.2023 · Materiál: sérum</div>
  <table>
    <tr><th>Analyt</th><th class="num">Výsledek</th><th>Jednotka</th><th>Referenční rozmezí</th></tr>
    <tr><td>Glukóza</td><td class="num">5,1</td><td>mmol/l</td><td>3,9 - 5,6</td></tr>
    <tr><td>Cholesterol</td><td class="num">4,8</td><td>mmol/l</td><td>&lt; 5,0</td></tr>
    <tr><td>Triglyceridy</td><td class="num">1,2</td><td>mmol/l</td><td>do 1,7</td></tr>
    <tr><td>HDL cholesterol</td><td class="num">1,6</td><td>mmol/l</td><td>nad 1,0</td></tr>
    <tr><td>CRP</td><td class="num">&lt; 0,10</td><td>mg/l</td><td>do 5,0</td></tr>
    <tr><td>Ferritin</td><td class="num">120</td><td>ug/l</td><td>30 - 400</td></tr>
    <tr><td>TSH</td><td class="num">2,4</td><td>mIU/l</td><td>0,27 - 4,20</td></tr>
  </table>
</body></html>`;

// The other common Czech column order, printed by several laboratory systems:
// the evaluation bar sits BETWEEN the value and the reference range, the unit
// column follows the range, and each row closes with the one-letter sample type
// (B = blood, S = serum, G = fluoride plasma, U = urine — the same national
// convention as the S_/U_ name prefixes). Read with the other order in mind,
// every row of such a sheet yields the upper reference bound instead of the
// result, so the layout has a fixture of its own. Fully synthetic.
const HTML_UNIT_LAST = `<!doctype html><html lang="cs"><head><meta charset="utf-8">
<style>
  body { font-family: Arial, sans-serif; font-size: 11px; color: #000; padding: 22px; }
  h1 { font-size: 15px; margin: 0 0 2px; }
  .meta { font-size: 10px; color: #333; margin-bottom: 10px; }
  .sec { font-weight: bold; margin: 10px 0 4px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 2px 6px; border-bottom: 1px solid #ddd; }
  th { border-bottom: 1px solid #000; font-size: 10px; }
  .num { text-align: right; }
  .bar { font-family: monospace; letter-spacing: 1px; }
</style></head><body>
  <h1>Výsledkový list</h1>
  <div class="meta">Pacient: Testovací Vzor · Odběr: 02.03.2026 07:15 · Laboratorní č.: 1000001</div>

  <div class="sec">Hematologie</div>
  <table>
    <tr><th>Název vyšetření</th><th class="num">Výsledek</th><th class="bar">Hodnocení</th><th>Referenční meze</th><th>Jednotka</th><th>Materiál</th></tr>
    <tr><td>Leukocyty [WBC]</td><td class="num">6,2</td><td class="bar">| |*| |</td><td>4,0 - 10,0</td><td>10^9/l</td><td>B</td></tr>
    <tr><td>Hematokrit [HCT]</td><td class="num">0,441</td><td class="bar">| |*| |</td><td>0,400 - 0,500</td><td>l/l</td><td>B</td></tr>
    <tr><td>Neutrofily - relativně</td><td class="num">55,0</td><td class="bar">| |*| |</td><td>45,0 - 70,0</td><td>%</td><td>B</td></tr>
    <tr><td>Neutrofily - abs.počet</td><td class="num">3,41</td><td class="bar">| |*| |</td><td>2,00 - 7,00</td><td>10^9/l</td><td>B</td></tr>
  </table>

  <div class="sec">Biochemie</div>
  <table>
    <tr><th>Název vyšetření</th><th class="num">Výsledek</th><th class="bar">Hodnocení</th><th>Referenční meze</th><th>Jednotka</th><th>Materiál</th></tr>
    <tr><td>Kyselina močová</td><td class="num">325</td><td class="bar">| |*| |</td><td>220 - 420</td><td>µmol/l</td><td>S</td></tr>
    <tr><td>Glukóza v plazmě</td><td class="num">5,13</td><td class="bar">| |*| |</td><td>3,50 - 5,59</td><td>mmol/l</td><td>G</td></tr>
    <tr><td>Non-HDL cholesterol - výp</td><td class="num">3,1</td><td class="bar">| |*| |</td><td>0,0 - 3,7</td><td>mmol/l</td><td>S</td></tr>
  </table>

  <div class="sec">Moč — chemicky</div>
  <table>
    <tr><th>Název vyšetření</th><th class="num">Výsledek</th><th class="bar">Hodnocení</th><th>Referenční meze</th><th>Jednotka</th><th>Materiál</th></tr>
    <tr><td>Glukóza</td><td class="num">negativní</td><td class="bar"></td><td>negativní</td><td></td><td>U</td></tr>
  </table>
</body></html>`;

// An English-language chemistry panel (fully fictional "John Q. Doe"), to
// cover the English parsing path with a committed fixture.
const HTML_EN = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<style>
  body { font-family: Arial, sans-serif; font-size: 11px; color: #000; padding: 24px; }
  h1 { font-size: 15px; margin: 0 0 2px; }
  .meta { font-size: 10px; color: #333; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 3px 6px; border-bottom: 1px solid #ccc; }
  th { border-bottom: 2px solid #000; }
  .num { text-align: right; }
  .flag { color: #b00; font-weight: bold; }
</style></head><body>
  <h1>Laboratory Report — Chemistry</h1>
  <div class="meta">Patient: John Q. Doe (fictional) · Collected: 2023-08-14 · Specimen: serum</div>
  <table>
    <tr><th>Test</th><th class="num">Result</th><th>Flag</th><th>Units</th><th>Reference Range</th></tr>
    <tr><td>Glucose</td><td class="num">99</td><td></td><td>mg/dL</td><td>74 - 100</td></tr>
    <tr><td>Total cholesterol</td><td class="num">205</td><td class="flag">H</td><td>mg/dL</td><td>&lt; 200</td></tr>
    <tr><td>LDL cholesterol</td><td class="num">130</td><td class="flag">H</td><td>mg/dL</td><td>&lt; 100</td></tr>
    <tr><td>HDL cholesterol</td><td class="num">55</td><td></td><td>mg/dL</td><td>&gt; 40</td></tr>
    <tr><td>Triglycerides</td><td class="num">120</td><td></td><td>mg/dL</td><td>&lt; 150</td></tr>
    <tr><td>Creatinine</td><td class="num">0.9</td><td></td><td>mg/dL</td><td>0.7 - 1.3</td></tr>
    <tr><td>TSH</td><td class="num">2.1</td><td></td><td>mIU/L</td><td>0.27 - 4.2</td></tr>
    <tr><td>Ferritin</td><td class="num">120</td><td></td><td>ng/mL</td><td>30 - 400</td></tr>
  </table>
</body></html>`;

// A third, INLINE Czech layout (SmartMedix / PRAKTIK style): results are prose,
// semicolon-separated `Analyt: hodnota jednotka (meze)` inside "Odebráno:"
// blocks that wrap across lines — the format the generic tabular parser cannot
// read. Synthetic patient + practice; no real data or branding.
const HTML_PRAKTIK = `<!doctype html><html lang="cs"><head><meta charset="utf-8">
<style>
  body { font-family: Arial, sans-serif; font-size: 11px; color: #000; padding: 24px; line-height: 1.5; }
  h1 { font-size: 14px; margin: 0 0 4px; }
  .meta { font-size: 10px; color: #333; margin-bottom: 10px; }
  p { margin: 6px 0; }
  .sec { font-weight: bold; margin-top: 10px; }
</style></head><body>
  <h1>Kontinuální denní záznam pacienta</h1>
  <div class="meta">Ordinace: Praktik Vzor s.r.o. · Pacient: Testovací Vzor (nar. 1980) · rč: 800101/0000</div>
  <p class="sec">Laboratorní výsledky:</p>
  <p>Odebráno: 14.02.2026 07:35:00 hematologie WBC - leukocyty: 8,56 10^9/L; RBC - erytrocyty: 5,56 10^12/L; HGB - hemoglobin: 165 g/L; HCT - hematokrit: 0,516 L/L (0,4-0,5) ; MCV - stř.obj. ery.: 92,8 fL; PLT - trombocyty: 255 10^9/L;</p>
  <p>Odebráno: 14.02.2026 07:35:00 diabetologie Glukóza: 5,5 mmol/L; Cholesterol: 5,9 mmol/L (2,9-5) ; Triacylglyceroly: 1,6 mmol/L; Kreatinin enzymaticky: 91 μmol/L; Cholesterol HDL: 1,05 mmol/L; Cholesterol LDL: 4,58 mmol/L (0-3) ; Kyselina močová: 501 μmol/L (220-450) ; ALT: 0,86 μkat/L (0,17-0,78) ; AST: 0,77 μkat/L (0,16-0,72) ;</p>
  <p>Odebráno: 14.02.2026 07:35:00 moč chemicky Bílkovina: negativní; Glukóza: negativní; Ketolátky: negativní; pH: 5,5; Erytrocyty: <4 počet/μL; Leukocyty: <3 počet/μL;</p>
</body></html>`;

// A COMPREHENSIVE Czech "výsledkový list" — a realistic multi-panel result
// sheet (blood count, biochemistry, lipids, kidney/liver, thyroid, vitamins,
// urine) with mixed reference-range styles and H/L flags. Fully synthetic
// patient and provider; no real lab branding. This is the broad end-to-end
// exercise for the tabular PDF parser + the CZ alias pack.
const HTML_FULL = `<!doctype html><html lang="cs"><head><meta charset="utf-8">
<style>
  body { font-family: Arial, sans-serif; font-size: 10.5px; color: #000; padding: 20px; }
  h1 { font-size: 15px; margin: 0 0 2px; }
  .prov { font-size: 12px; font-weight: bold; margin-bottom: 2px; }
  .meta { font-size: 10px; color: #333; margin-bottom: 10px; }
  .sec { font-size: 11px; font-weight: bold; margin: 12px 0 3px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 2px 6px; border-bottom: 1px solid #ddd; }
  th { border-bottom: 1.5px solid #000; font-size: 9.5px; }
  .num { text-align: right; }
  .flag { color: #b00; font-weight: bold; text-align: center; }
</style></head><body>
  <div class="prov">Laboratoř Vzor a.s. — klinická biochemie a hematologie</div>
  <h1>Výsledkový list</h1>
  <div class="meta">Pacient: Testovací Vzor (nar. 1980) · Poj.: 000 · Odběr: 12.03.2026 07:20 · Materiál: sérum, plná krev, moč</div>

  <div class="sec">Krevní obraz</div>
  <table>
    <tr><th>Vyšetření</th><th class="num">Výsledek</th><th>Hodn.</th><th>Jednotka</th><th>Referenční meze</th></tr>
    <tr><td>Leukocyty</td><td class="num">8,56</td><td class="flag"></td><td>10^9/l</td><td>4,0 - 10,0</td></tr>
    <tr><td>Erytrocyty</td><td class="num">5,56</td><td class="flag">H</td><td>10^12/l</td><td>4,0 - 5,2</td></tr>
    <tr><td>Hemoglobin</td><td class="num">165</td><td class="flag"></td><td>g/l</td><td>135 - 175</td></tr>
    <tr><td>Hematokrit</td><td class="num">0,49</td><td class="flag"></td><td>l/l</td><td>0,40 - 0,50</td></tr>
    <tr><td>Střední objem erytrocytu</td><td class="num">88,5</td><td class="flag"></td><td>fl</td><td>82 - 98</td></tr>
    <tr><td>Trombocyty</td><td class="num">255</td><td class="flag"></td><td>10^9/l</td><td>150 - 400</td></tr>
  </table>

  <div class="sec">Biochemie — základní</div>
  <table>
    <tr><th>Vyšetření</th><th class="num">Výsledek</th><th>Hodn.</th><th>Jednotka</th><th>Referenční meze</th></tr>
    <tr><td>Glukóza</td><td class="num">5,4</td><td class="flag"></td><td>mmol/l</td><td>3,9 - 5,6</td></tr>
    <tr><td>Glykovaný hemoglobin (HbA1c)</td><td class="num">38</td><td class="flag"></td><td>mmol/mol</td><td>20 - 42</td></tr>
    <tr><td>Sodík</td><td class="num">140</td><td class="flag"></td><td>mmol/l</td><td>136 - 145</td></tr>
    <tr><td>Draslík</td><td class="num">4,3</td><td class="flag"></td><td>mmol/l</td><td>3,5 - 5,1</td></tr>
    <tr><td>Chloridy</td><td class="num">102</td><td class="flag"></td><td>mmol/l</td><td>98 - 107</td></tr>
    <tr><td>Vápník</td><td class="num">2,35</td><td class="flag"></td><td>mmol/l</td><td>2,10 - 2,55</td></tr>
    <tr><td>CRP</td><td class="num">&lt; 1,0</td><td class="flag"></td><td>mg/l</td><td>do 5,0</td></tr>
  </table>

  <div class="sec">Lipidové spektrum</div>
  <table>
    <tr><th>Vyšetření</th><th class="num">Výsledek</th><th>Hodn.</th><th>Jednotka</th><th>Referenční meze</th></tr>
    <tr><td>Cholesterol celkový</td><td class="num">5,9</td><td class="flag">H</td><td>mmol/l</td><td>&lt; 5,0</td></tr>
    <tr><td>LDL cholesterol</td><td class="num">3,6</td><td class="flag">H</td><td>mmol/l</td><td>&lt; 3,0</td></tr>
    <tr><td>HDL cholesterol</td><td class="num">1,3</td><td class="flag"></td><td>mmol/l</td><td>nad 1,0</td></tr>
    <tr><td>Triglyceridy</td><td class="num">1,8</td><td class="flag">H</td><td>mmol/l</td><td>do 1,7</td></tr>
  </table>

  <div class="sec">Ledviny a játra</div>
  <table>
    <tr><th>Vyšetření</th><th class="num">Výsledek</th><th>Hodn.</th><th>Jednotka</th><th>Referenční meze</th></tr>
    <tr><td>Kreatinin</td><td class="num">78</td><td class="flag"></td><td>umol/l</td><td>64 - 104</td></tr>
    <tr><td>Urea</td><td class="num">5,1</td><td class="flag"></td><td>mmol/l</td><td>2,8 - 8,1</td></tr>
    <tr><td>Kyselina močová</td><td class="num">320</td><td class="flag"></td><td>umol/l</td><td>202 - 417</td></tr>
    <tr><td>ALT</td><td class="num">0,52</td><td class="flag"></td><td>ukat/l</td><td>0,10 - 0,78</td></tr>
    <tr><td>AST</td><td class="num">0,48</td><td class="flag"></td><td>ukat/l</td><td>0,10 - 0,72</td></tr>
    <tr><td>GGT</td><td class="num">0,61</td><td class="flag"></td><td>ukat/l</td><td>0,14 - 0,84</td></tr>
    <tr><td>Bilirubin celkový</td><td class="num">12</td><td class="flag"></td><td>umol/l</td><td>2 - 21</td></tr>
  </table>

  <div class="sec">Štítná žláza a vitamíny</div>
  <table>
    <tr><th>Vyšetření</th><th class="num">Výsledek</th><th>Hodn.</th><th>Jednotka</th><th>Referenční meze</th></tr>
    <tr><td>TSH</td><td class="num">2,10</td><td class="flag"></td><td>mIU/l</td><td>0,27 - 4,20</td></tr>
    <tr><td>Volný tyroxin (fT4)</td><td class="num">15,8</td><td class="flag"></td><td>pmol/l</td><td>12,0 - 22,0</td></tr>
    <tr><td>Vitamin D</td><td class="num">62</td><td class="flag">L</td><td>nmol/l</td><td>75 - 200</td></tr>
    <tr><td>Vitamin B12</td><td class="num">310</td><td class="flag"></td><td>pmol/l</td><td>145 - 569</td></tr>
    <tr><td>Ferritin</td><td class="num">120</td><td class="flag"></td><td>ug/l</td><td>30 - 400</td></tr>
  </table>

  <div class="sec">Moč — chemicky (dipstick)</div>
  <table>
    <tr><th>Vyšetření</th><th class="num">Výsledek</th><th>Hodn.</th><th>Jednotka</th><th>Referenční meze</th></tr>
    <tr><td>pH moči</td><td class="num">5,5</td><td class="flag"></td><td>pH</td><td>5,0 - 6,5</td></tr>
    <tr><td>Glukóza v moči</td><td class="num">negativní</td><td class="flag"></td><td></td><td>negativní</td></tr>
    <tr><td>Ketolátky v moči</td><td class="num">negativní</td><td class="flag"></td><td></td><td>negativní</td></tr>
    <tr><td>Bilirubin v moči</td><td class="num">negativní</td><td class="flag"></td><td></td><td>negativní</td></tr>
    <tr><td>Urobilinogen v moči</td><td class="num">normální</td><td class="flag"></td><td></td><td>normální</td></tr>
    <tr><td>Nitrity v moči</td><td class="num">negativní</td><td class="flag"></td><td></td><td>negativní</td></tr>
    <tr><td>Krev v moči</td><td class="num">stopy</td><td class="flag"></td><td></td><td>negativní</td></tr>
    <tr><td>Leukocyty v moči</td><td class="num">pozitivní</td><td class="flag">+</td><td></td><td>negativní</td></tr>
  </table>
</body></html>`;

// A Czech result sheet in the NČLP house style used by hospital and chain lab
// information systems: two narrow code columns on the left, every analyte
// prefixed with its tissue system (S_/P_/B_/U_/C_), a graphical in-range
// "evaluation" bar on the right, and — the trap — the patient's DATE OF BIRTH
// printed above the draw date. Several rows deliberately state no unit at all
// (ratios and the computed index), which is how these sheets really look.
// Fully synthetic: invented patient, invented lab, invented values.
const HTML_NCLP = `<!doctype html><html lang="cs"><head><meta charset="utf-8">
<style>
  body { font-family: Arial, sans-serif; font-size: 10px; color: #000; padding: 18px; }
  h1 { font-size: 14px; margin: 0 0 2px; }
  .prov { font-size: 11px; font-weight: bold; margin-bottom: 2px; }
  .meta { font-size: 9.5px; color: #222; margin-bottom: 8px; }
  .meta div { margin: 1px 0; }
  .sec { font-size: 10.5px; font-weight: bold; margin: 9px 0 2px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 1.5px 5px; }
  th { border-bottom: 1px solid #000; font-size: 9px; }
  .code { color: #444; width: 58px; }
  .num { text-align: right; width: 62px; }
  .unit { width: 74px; }
  .ref { width: 92px; text-align: right; }
  .bar { font-family: monospace; letter-spacing: 1px; width: 96px; }
</style></head><body>
  <div class="prov">Laboratoře Vzor — pracoviště VZR</div>
  <h1>Výsledkový list</h1>
  <div class="meta">
    <div>k průvodce číslo: 260814/VZR/00001 Rutina</div>
    <div>NOVÁK JAN &nbsp;&nbsp; Datum narození: 3.4.1979 &nbsp;&nbsp; Věk: 47 &nbsp;&nbsp; Pohlaví: M</div>
    <div>Odběr: 14.08.2026 06:45 &nbsp;&nbsp; Přijato: 14.08.2026 06:52</div>
  </div>

  <div class="sec">Biochemie — krev</div>
  <table>
    <tr><th>Kód</th><th>Název vyšetření</th><th class="num">Výsledek</th><th class="unit">Jednotka</th><th class="ref">Meze</th><th class="bar">Hodnocení</th></tr>
    <tr><td class="code">VZR AM</td><td>S_Kreatinin</td><td class="num">91</td><td class="unit">µmol/L</td><td class="ref">64 - 104</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR</td><td>C_CKD-EPI 2021</td><td class="num">1,48</td><td class="unit">ml/s/1,73 m2</td><td class="ref">1,50 - 3,00</td><td class="bar">| |* | |</td></tr>
    <tr><td class="code">VZR AM</td><td>S_Kyselina močová</td><td class="num">402</td><td class="unit">µmol/L</td><td class="ref">230 - 480</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR AM</td><td>S_Na</td><td class="num">139</td><td class="unit">mmol/L</td><td class="ref">137 - 145</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR AM</td><td>S_K</td><td class="num">4,1</td><td class="unit">mmol/L</td><td class="ref">3,5 - 5,1</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR</td><td>S_Zn</td><td class="num">12,4</td><td class="unit">µmol/L</td><td class="ref">10,7 - 18,4</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR AM</td><td>S_ALT</td><td class="num">0,55</td><td class="unit">µkat/L</td><td class="ref">0,17 - 1,17</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR</td><td>C_FIB-4</td><td class="num">1,07</td><td class="unit"></td><td class="ref"></td><td class="bar"></td></tr>
    <tr><td class="code">VZR AM</td><td>S_Cholesterol</td><td class="num">4,42</td><td class="unit">mmol/L</td><td class="ref">2,90 - 5,00</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR</td><td>C_Non-HDL cholesterol</td><td class="num">3,0</td><td class="unit">mmol/L</td><td class="ref">0,0 - 3,8</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR</td><td>S_Apo B</td><td class="num">0,88</td><td class="unit">g/L</td><td class="ref">0,50 - 1,00</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR</td><td>S_hsCRP</td><td class="num">0,74</td><td class="unit">mg/L</td><td class="ref">0,00 - 3,00</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR</td><td>S_25OH vitamin D</td><td class="num">88,5</td><td class="unit">nmol/L</td><td class="ref">75,0 - 250,0</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR</td><td>S_Folát</td><td class="num">12,3</td><td class="unit"></td><td class="ref">7,0 - 46,0</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR AM</td><td>S_TSH</td><td class="num">1,904</td><td class="unit">mU/L</td><td class="ref">0,550 - 4,780</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR AM</td><td>P_Glukóza</td><td class="num">5,2</td><td class="unit">mmol/L</td><td class="ref">3,9 - 5,6</td><td class="bar">| |*| |</td></tr>
  </table>

  <div class="sec">Hematologie — krevní obraz</div>
  <table>
    <tr><th>Kód</th><th>Název vyšetření</th><th class="num">Výsledek</th><th class="unit">Jednotka</th><th class="ref">Meze</th><th class="bar">Hodnocení</th></tr>
    <tr><td class="code">VZR AM</td><td>B_Leukocyty</td><td class="num">7,2</td><td class="unit">10^9/L</td><td class="ref">4,0 - 10,0</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR AM</td><td>B_Erytrocyty</td><td class="num">5,01</td><td class="unit">10^12/L</td><td class="ref">4,00 - 5,80</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR AM</td><td>B_Hemoglobin</td><td class="num">152</td><td class="unit">g/L</td><td class="ref">135 - 175</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR AM</td><td>B_Hematokrit</td><td class="num">0,451</td><td class="unit"></td><td class="ref">0,400 - 0,500</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR AM</td><td>B_MCV</td><td class="num">90,0</td><td class="unit">fl</td><td class="ref">82,0 - 98,0</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR</td><td>B_PDW</td><td class="num">15,1</td><td class="unit">fl</td><td class="ref">9,0 - 17,0</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR</td><td>B_Normoblasty</td><td class="num">0,000</td><td class="unit"></td><td class="ref">0,000 - 0,001</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR</td><td>B_Normoblasty abs. počet</td><td class="num">0,000</td><td class="unit">10^9/L</td><td class="ref">0,000 - 0,015</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR AM</td><td>B_Neutrofily</td><td class="num">0,551</td><td class="unit"></td><td class="ref">0,450 - 0,700</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR AM</td><td>B_Neutrofily abs. počet</td><td class="num">3,97</td><td class="unit">10^9/L</td><td class="ref">2,00 - 7,00</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR AM</td><td>B_Lymfocyty abs. počet</td><td class="num">2,31</td><td class="unit">10^9/L</td><td class="ref">0,80 - 4,00</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR AM</td><td>B_Monocyty abs. počet</td><td class="num">0,62</td><td class="unit">10^9/L</td><td class="ref">0,08 - 1,20</td><td class="bar">| |*| |</td></tr>
    <tr><td class="code">VZR</td><td>B_Nezralé granulocyty abs.počet</td><td class="num">0,021</td><td class="unit">10^9/L</td><td class="ref">0,000 - 0,060</td><td class="bar">| |*| |</td></tr>
  </table>

  <div class="sec">Moč — chemicky</div>
  <table>
    <tr><th>Kód</th><th>Název vyšetření</th><th class="num">Výsledek</th><th class="unit">Jednotka</th><th class="ref">Meze</th><th class="bar">Hodnocení</th></tr>
    <tr><td class="code">VZR</td><td>U_Glukóza</td><td class="num">negativní</td><td class="unit"></td><td class="ref">negativní</td><td class="bar"></td></tr>
    <tr><td class="code">VZR</td><td>U_pH</td><td class="num">6,0</td><td class="unit">pH</td><td class="ref">5,0 - 6,5</td><td class="bar">| |*| |</td></tr>
  </table>

  <div style="margin-top:10px; font-size:8.5px; color:#333">
    AM = metoda v rozsahu akreditace. Legenda tkáňového systému: S_sérum, P_plazma, B_krev,
    U_moč, dU_odpad v moči, F_stolice, Pu_punktát.<br>
    Sestaveno a vydáno: 14. 08. 2026 12:18
  </div>
</body></html>`;

async function main() {
  mkdirSync('test/fixtures', { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const pdfOpts = {
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' },
    };
    await page.setContent(HTML, { waitUntil: 'load' });
    await page.pdf({ path: 'test/fixtures/labs/cz/lab-cs-result.pdf', ...pdfOpts });
    await page.setContent(HTML_SYNLAB, { waitUntil: 'load' });
    await page.pdf({ path: 'test/fixtures/labs/cz/lab-cs-synlab.pdf', ...pdfOpts });
    await page.setContent(HTML_EN, { waitUntil: 'load' });
    await page.pdf({ path: 'test/fixtures/labs/foreign/lab-en-chemistry.pdf', ...pdfOpts });
    await page.setContent(HTML_PRAKTIK, { waitUntil: 'load' });
    await page.pdf({ path: 'test/fixtures/labs/cz/lab-cs-praktik.pdf', ...pdfOpts });
    await page.setContent(HTML_FULL, { waitUntil: 'load' });
    await page.pdf({ path: 'test/fixtures/labs/cz/lab-cs-full.pdf', ...pdfOpts });
    await page.setContent(HTML_NCLP, { waitUntil: 'load' });
    await page.pdf({ path: 'test/fixtures/labs/cz/lab-cs-nclp.pdf', ...pdfOpts });
    await page.setContent(HTML_UNIT_LAST, { waitUntil: 'load' });
    await page.pdf({ path: 'test/fixtures/labs/cz/lab-cs-unit-last.pdf', ...pdfOpts });
  } finally {
    await browser.close();
  }
  console.log(
    'Wrote lab-cs-result.pdf, lab-cs-synlab.pdf, lab-en-chemistry.pdf, lab-cs-praktik.pdf, ' +
      'lab-cs-full.pdf, lab-cs-nclp.pdf, lab-cs-unit-last.pdf',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
