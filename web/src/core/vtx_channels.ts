import { esc } from "./format";
import type { CanvasSelectOption } from "../widgets/CanvasSelect";

export const BAND_RACEBAND = 1;
export const BAND_FATSHARK = 2;
export const BAND_BOSCAM_E = 3;
export const BAND_BOSCAM_A = 4;
export const BAND_IMD6 = 5;
export const BAND_BOSCAM_B = 6;

export interface VtxBandSpec {
  band: number;
  prefix: string;
  name: string;
  groupLabel: string;
  voiceName: string;
  frequenciesMHz: readonly number[];
  /** 1-based channel indices legal in 5650–5925 MHz amateur FPV racing spectrum. */
  legalChannels: readonly number[];
}

export const RACEBAND_FREQUENCIES_MHZ = [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917] as const;
export const FATSHARK_FREQUENCIES_MHZ = [5740, 5760, 5780, 5800, 5820, 5840, 5860, 5880] as const;
export const BOSCAM_A_FREQUENCIES_MHZ = [5865, 5845, 5825, 5805, 5785, 5765, 5745, 5725] as const;
export const BOSCAM_B_FREQUENCIES_MHZ = [5733, 5752, 5771, 5790, 5809, 5828, 5847, 5866] as const;
export const BOSCAM_E_FREQUENCIES_MHZ = [5705, 5685, 5665, 5645, 5885, 5905, 5925, 5945] as const;
export const IMD6_FREQUENCIES_MHZ = [5658, 5695, 5760, 5800, 5880, 5917] as const;

/** Ordered list of standard 5.8 GHz FPV racing bands shown in dropdowns. */
export const VTX_BANDS: readonly VtxBandSpec[] = [
  {
    band: BAND_RACEBAND,
    prefix: "R",
    name: "Raceband",
    groupLabel: "Raceband",
    voiceName: "Raceband",
    frequenciesMHz: RACEBAND_FREQUENCIES_MHZ,
    legalChannels: [1, 2, 3, 4, 5, 6, 7, 8],
  },
  {
    band: BAND_FATSHARK,
    prefix: "F",
    name: "Fatshark",
    groupLabel: "Fatshark / IRC",
    voiceName: "Fatshark",
    frequenciesMHz: FATSHARK_FREQUENCIES_MHZ,
    legalChannels: [1, 2, 3, 4, 5, 6, 7, 8],
  },
  {
    band: BAND_BOSCAM_A,
    prefix: "A",
    name: "Boscam A",
    groupLabel: "Boscam A",
    voiceName: "Boscam A",
    frequenciesMHz: BOSCAM_A_FREQUENCIES_MHZ,
    legalChannels: [1, 2, 3, 4, 5, 6, 7, 8],
  },
  {
    band: BAND_BOSCAM_B,
    prefix: "B",
    name: "Boscam B",
    groupLabel: "Boscam B",
    voiceName: "Boscam B",
    frequenciesMHz: BOSCAM_B_FREQUENCIES_MHZ,
    legalChannels: [1, 2, 3, 4, 5, 6, 7, 8],
  },
  {
    band: BAND_BOSCAM_E,
    prefix: "E",
    name: "Boscam E",
    groupLabel: "Boscam E",
    voiceName: "Boscam E",
    frequenciesMHz: BOSCAM_E_FREQUENCIES_MHZ,
    // E4 (5645 MHz) & E8 (5945 MHz) lie outside the legal 5650–5925 MHz amateur band
    legalChannels: [1, 2, 3, 5, 6, 7],
  },
  {
    band: BAND_IMD6,
    prefix: "I",
    name: "IMD6",
    groupLabel: "IMD6",
    voiceName: "IMD6",
    frequenciesMHz: IMD6_FREQUENCIES_MHZ,
    legalChannels: [1, 2, 3, 4, 5, 6],
  },
];

const BAND_BY_ID = new Map<number, VtxBandSpec>(VTX_BANDS.map((b) => [b.band, b]));

export function normalizeBand(band?: number | null): number {
  if (band && BAND_BY_ID.has(band)) return band;
  return BAND_RACEBAND;
}

export function bandPrefix(band?: number | null): string {
  return BAND_BY_ID.get(normalizeBand(band))?.prefix ?? "R";
}

export function bandName(band?: number | null): string {
  return BAND_BY_ID.get(normalizeBand(band))?.name ?? "Raceband";
}

export function bandVoiceName(band?: number | null): string {
  return BAND_BY_ID.get(normalizeBand(band))?.voiceName ?? "Raceband";
}

export function frequencyForBandChannel(band?: number | null, channel?: number | null): number {
  const ch = Math.round(Number(channel) || 0);
  if (ch < 1) return 0;
  const spec = BAND_BY_ID.get(normalizeBand(band));
  if (!spec || ch > spec.frequenciesMHz.length) return 0;
  return spec.frequenciesMHz[ch - 1] ?? 0;
}

/**
 * Encodes `(band, channel)` into a backward-compatible uint8 integer code:
 * - Raceband 1..8 -> `1..8`
 * - Other bands -> `band * 10 + channel` (e.g. F4 = 24, E2 = 32, A1 = 41, I3 = 53, B2 = 62)
 */
export function encodeBandChannel(band?: number | null, channel?: number | null): number {
  const ch = Math.round(Number(channel) || 0);
  if (ch < 1) return 0;
  const b = normalizeBand(band);
  if (frequencyForBandChannel(b, ch) <= 0) return 0;
  return b === BAND_RACEBAND ? ch : b * 10 + ch;
}

export function decodeBandChannel(
  code?: number | string | null
): { band: number; channel: number; frequencyMhz: number; encoded: number } | null {
  const n = Math.round(Number(code) || 0);
  if (n >= 1 && n <= 8) {
    const freq = RACEBAND_FREQUENCIES_MHZ[n - 1];
    return { band: BAND_RACEBAND, channel: n, frequencyMhz: freq, encoded: n };
  }
  if (n >= 11 && n <= 255) {
    const b = Math.floor(n / 10);
    const ch = n % 10;
    const freq = frequencyForBandChannel(b, ch);
    if (freq > 0) {
      return {
        band: b,
        channel: ch,
        frequencyMhz: freq,
        encoded: b === BAND_RACEBAND ? ch : b * 10 + ch,
      };
    }
  }
  return null;
}

export function isValidEncodedSeatChannel(code?: number | null): boolean {
  return decodeBandChannel(code) !== null;
}

export function lookupBandChannelByFreqMHz(
  mhz?: number | null
): { band: number; channel: number; shortCode: string } | null {
  const target = Math.round(Number(mhz) || 0);
  if (target < 5000 || target > 6100) return null;
  const lookupOrder = [
    BAND_RACEBAND,
    BAND_FATSHARK,
    BAND_BOSCAM_A,
    BAND_BOSCAM_B,
    BAND_BOSCAM_E,
  ];
  for (const bandId of lookupOrder) {
    const spec = BAND_BY_ID.get(bandId);
    if (!spec) continue;
    const idx = spec.frequenciesMHz.indexOf(target);
    if (idx >= 0) {
      const ch = idx + 1;
      return { band: bandId, channel: ch, shortCode: `${spec.prefix}${ch}` };
    }
  }
  return null;
}

export function formatBandChannelShort(band?: number | null, channel?: number | null): string {
  const ch = Math.round(Number(channel) || 0);
  if (ch <= 0) return "";
  return `${bandPrefix(band)}${ch}`;
}

export function formatEncodedChannelShort(code?: number | null): string {
  const dec = decodeBandChannel(code);
  if (!dec) return "";
  return formatBandChannelShort(dec.band, dec.channel);
}

export function formatBandChannelWithFreq(
  band?: number | null,
  channel?: number | null,
  freqMhz?: number | null,
  includeUnit = true
): string {
  const ch = Math.round(Number(channel) || 0);
  if (ch <= 0) return "";
  const short = formatBandChannelShort(band, ch);
  const mhz =
    freqMhz && freqMhz > 0 ? Math.round(freqMhz) : frequencyForBandChannel(band, ch);
  if (mhz <= 0) return short;
  return includeUnit ? `${short} · ${mhz} MHz` : `${short} · ${mhz}`;
}

export function formatSeatVoiceChannel(band?: number | null, channel?: number | null): string {
  const ch = Math.round(Number(channel) || 0);
  if (ch <= 0) return "unassigned channel";
  return `${bandVoiceName(band)} ${ch}`;
}

export function pilotChannelSearchTokens(
  band?: number | null,
  channel?: number | null,
  freqMhz?: number | null
): string {
  const ch = Math.round(Number(channel) || 0);
  if (ch <= 0) return "no default";
  const b = normalizeBand(band);
  const short = formatBandChannelShort(b, ch).toLowerCase();
  const bName = bandName(b).toLowerCase();
  const mhz =
    freqMhz && freqMhz > 0 ? Math.round(freqMhz) : frequencyForBandChannel(b, ch);
  return `${short} ${bName} ${bName}${ch} ${mhz > 0 ? mhz : ""}`.trim();
}

export interface MultiBandSelectOptionsParams {
  selectedBand?: number | null;
  selectedChannel?: number | null;
  selectedEncoded?: number | null;
  includeUnassigned?: boolean;
  unassignedLabel?: string;
  compact?: boolean;
  subFreq?: boolean;
}

/**
 * Builds grouped `<optgroup>` HTML for `<select class="input">` across all legal 5.8 GHz FPV bands.
 */
export function renderMultiBandSelectOptionsHtml(params: MultiBandSelectOptionsParams): string {
  const selCode =
    params.selectedEncoded !== undefined && params.selectedEncoded !== null
      ? (decodeBandChannel(params.selectedEncoded)?.encoded ?? 0)
      : encodeBandChannel(params.selectedBand, params.selectedChannel);

  let html = "";
  if (params.includeUnassigned) {
    const lbl = params.unassignedLabel ?? "No default";
    html += `<option value="0" ${selCode === 0 ? "selected" : ""}>${esc(lbl)}</option>`;
  }

  for (const spec of VTX_BANDS) {
    let optsHtml = "";
    for (let idx = 0; idx < spec.frequenciesMHz.length; idx++) {
      const ch = idx + 1;
      const mhz = spec.frequenciesMHz[idx];
      const code = encodeBandChannel(spec.band, ch);
      const isSelected = selCode === code;
      if (!spec.legalChannels.includes(ch) && !isSelected) {
        continue;
      }
      if (params.subFreq) {
        optsHtml += `<option value="${code}" data-sub="${mhz} MHz" ${isSelected ? "selected" : ""}>${esc(`${spec.prefix}${ch}`)}</option>`;
      } else {
        const label = params.compact
          ? `${spec.prefix}${ch} · ${mhz}`
          : `${spec.prefix}${ch} · ${mhz} MHz`;
        optsHtml += `<option value="${code}" ${isSelected ? "selected" : ""}>${esc(label)}</option>`;
      }
    }
    if (optsHtml) {
      html += `<optgroup label="${esc(spec.groupLabel)}">${optsHtml}</optgroup>`;
    }
  }
  return html;
}

/**
 * Builds grouped `CanvasSelectOption[]` for `renderCanvasSelect` (RoundModals, BracketDiagram, etc.).
 */
export function buildMultiBandCanvasOptions(opts?: {
  selectedCode?: number | null;
  includeFreq?: boolean;
}): CanvasSelectOption[] {
  const selCode = decodeBandChannel(opts?.selectedCode)?.encoded ?? 0;
  const includeFreq = opts?.includeFreq ?? true;
  const out: CanvasSelectOption[] = [];

  for (const spec of VTX_BANDS) {
    for (let idx = 0; idx < spec.frequenciesMHz.length; idx++) {
      const ch = idx + 1;
      const mhz = spec.frequenciesMHz[idx];
      const code = encodeBandChannel(spec.band, ch);
      if (!spec.legalChannels.includes(ch) && selCode !== code) {
        continue;
      }
      out.push({
        value: String(code),
        label: includeFreq ? `${spec.prefix}${ch} · ${mhz}` : `${spec.prefix}${ch}`,
        group: spec.groupLabel,
      });
    }
  }
  return out;
}
