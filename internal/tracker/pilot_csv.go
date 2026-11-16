package tracker

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"

	"slaprf/internal/domain"
)

func formatPilotCSVChannelCode(p domain.PilotSlot) string {
	return domain.BandShortCode(p.Band, p.Channel)
}

func parseCSVChannelSpec(raw string) (domain.Band, uint8, uint16, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return domain.BandRaceband, 0, 0, true
	}
	lower := strings.ToLower(s)
	switch lower {
	case "0", "-", "none", "no default", "unassigned", "n/a":
		return domain.BandRaceband, 0, 0, true
	}

	// Strip trailing suffix like "R4 · 5769 MHz" or "R4 (5769 MHz)"
	token := strings.FieldsFunc(s, func(r rune) bool {
		return r == ' ' || r == '·' || r == '(' || r == ')' || r == '/'
	})
	head := s
	if len(token) > 0 {
		head = strings.ToUpper(strings.TrimSpace(token[0]))
	}
	if len(head) == 2 && head[1] >= '1' && head[1] <= '8' {
		ch := uint8(head[1] - '0')
		var band domain.Band
		switch head[0] {
		case 'R':
			band = domain.BandRaceband
		case 'F':
			band = domain.BandFatshark
		case 'E':
			band = domain.BandBoscamE
		case 'A':
			band = domain.BandBoscamA
		case 'B':
			band = domain.BandBoscamB
		case 'I':
			band = domain.BandIMD6
		}
		if band != 0 {
			if freq := domain.FrequencyForBandChannel(band, ch); freq > 0 {
				return band, ch, freq, true
			}
		}
	}

	if n, err := strconv.Atoi(head); err == nil {
		if n == 0 {
			return domain.BandRaceband, 0, 0, true
		}
		if n >= 1 && n <= 8 {
			ch := uint8(n)
			return domain.BandRaceband, ch, domain.FrequencyForBandChannel(domain.BandRaceband, ch), true
		}
		if n >= 5000 && n <= 6100 {
			if band, ch, ok := domain.LookupBandChannelByFreqMHz(uint16(n)); ok {
				return band, ch, uint16(n), true
			}
		}
	}
	return 0, 0, 0, false
}

func normalizeCSVHeaderKey(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	var b strings.Builder
	lastUnderscore := false
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			lastUnderscore = false
		} else if !lastUnderscore && b.Len() > 0 {
			b.WriteByte('_')
			lastUnderscore = true
		}
	}
	return strings.TrimSuffix(b.String(), "_")
}

func detectCSVDelimiter(sample string) rune {
	firstLine := sample
	if idx := strings.IndexAny(sample, "\r\n"); idx >= 0 {
		firstLine = sample[:idx]
	}
	commas := strings.Count(firstLine, ",")
	semis := strings.Count(firstLine, ";")
	tabs := strings.Count(firstLine, "\t")
	if tabs > commas && tabs >= semis {
		return '\t'
	}
	if semis > commas {
		return ';'
	}
	return ','
}

// ExportPilotsCSV serializes the global pilot directory into an Excel-friendly UTF-8 CSV.
func (e *Engine) ExportPilotsCSV() string {
	e.mu.RLock()
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	e.mu.RUnlock()

	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	_ = w.Write([]string{
		"callsign",
		"phonetic_name",
		"channel",
		"enter_threshold_dbm",
		"exit_threshold_dbm",
		"laprf_gain",
		"laprf_threshold",
		"rh_enter_threshold",
		"rh_exit_threshold",
	})
	for _, p := range pilots {
		enterDbm := p.EnterThreshold
		if enterDbm == 0 {
			enterDbm = -58
		}
		exitDbm := p.ExitThreshold
		if exitDbm == 0 || exitDbm >= enterDbm {
			exitDbm = enterDbm - defaultExitGapDb
		}
		gain := p.AttenuationGain
		if gain == 0 {
			gain = domain.DefaultLapRFGain
		}
		laprfThr := p.LapRFThreshold
		if laprfThr <= 0 {
			laprfThr = domain.DefaultLapRFThreshold
		}
		rhEn := p.RHEnterThreshold
		if rhEn <= 0 {
			rhEn = domain.DefaultRHEnterThreshold
		}
		rhEx := p.RHExitThreshold
		if rhEx <= 0 || rhEx >= rhEn {
			rhEx = rhEn - defaultRHExitGap
		}
		_ = w.Write([]string{
			p.Callsign,
			p.PhoneticName,
			formatPilotCSVChannelCode(p),
			strconv.Itoa(int(math.Round(float64(enterDbm)))),
			strconv.Itoa(int(math.Round(float64(exitDbm)))),
			strconv.Itoa(int(gain)),
			strconv.Itoa(int(math.Round(float64(laprfThr)))),
			strconv.Itoa(int(math.Round(float64(rhEn)))),
			strconv.Itoa(int(math.Round(float64(rhEx)))),
		})
	}
	w.Flush()
	return buf.String()
}

type parsedPilotCSVRow struct {
	callsign   string
	hasPhon    bool
	phonetic   string
	hasChan    bool
	band       domain.Band
	channel    uint8
	freqMHz    uint16
	hasEnter   bool
	enterDbm   float32
	hasExit    bool
	exitDbm    float32
	hasGain    bool
	gain       uint16
	hasLaprfT  bool
	laprfThr   float32
	hasRHEnter bool
	rhEnter    float32
	hasRHExit  bool
	rhExit     float32
}

// ImportPilotsCSV performs a non-destructive upsert/merge of CSV pilot rows into the global directory:
// matching callsigns (case-insensitive) are updated in place without changing their SlotIndex or deleting
// any existing pilots, and unknown callsigns are appended as new pilots.
func (e *Engine) ImportPilotsCSV(csvText string) (domain.PilotCSVImportSummary, error) {
	cleaned := strings.TrimPrefix(csvText, "\uFEFF")
	cleaned = strings.TrimSpace(cleaned)
	if cleaned == "" {
		return domain.PilotCSVImportSummary{}, fmt.Errorf("CSV file is empty")
	}

	r := csv.NewReader(strings.NewReader(cleaned))
	r.Comma = detectCSVDelimiter(cleaned)
	r.FieldsPerRecord = -1
	r.TrimLeadingSpace = true

	var rawRows [][]string
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return domain.PilotCSVImportSummary{}, fmt.Errorf("invalid CSV format: %w", err)
		}
		nonEmpty := false
		for _, cell := range rec {
			if strings.TrimSpace(cell) != "" {
				nonEmpty = true
				break
			}
		}
		if nonEmpty {
			rawRows = append(rawRows, rec)
		}
	}
	if len(rawRows) == 0 {
		return domain.PilotCSVImportSummary{}, fmt.Errorf("CSV file contains no rows")
	}

	colCallsign := -1
	colPhonetic := -1
	colChannel := -1
	colEnter := -1
	colExit := -1
	colGain := -1
	colLaprfThr := -1
	colRHEnter := -1
	colRHExit := -1

	headerRecognized := false
	for idx, rawCol := range rawRows[0] {
		switch normalizeCSVHeaderKey(rawCol) {
		case "callsign", "pilot", "pilot_callsign", "pilot_name", "pilotname", "handle", "username", "user_name", "racer", "name":
			if colCallsign < 0 {
				colCallsign = idx
				headerRecognized = true
			}
		case "phonetic_name", "phonetic", "pronunciation", "spoken_name", "tts_name":
			if colPhonetic < 0 {
				colPhonetic = idx
				headerRecognized = true
			}
		case "channel", "default_channel", "vtx_channel", "vtx", "band_channel", "frequency", "freq", "frequency_mhz":
			if colChannel < 0 {
				colChannel = idx
				headerRecognized = true
			}
		case "enter_threshold_dbm", "enter_threshold", "enter_dbm", "threshold", "threshold_dbm":
			if colEnter < 0 {
				colEnter = idx
				headerRecognized = true
			}
		case "exit_threshold_dbm", "exit_threshold", "exit_dbm":
			if colExit < 0 {
				colExit = idx
				headerRecognized = true
			}
		case "laprf_gain", "attenuation_gain", "gain":
			if colGain < 0 {
				colGain = idx
				headerRecognized = true
			}
		case "laprf_threshold":
			if colLaprfThr < 0 {
				colLaprfThr = idx
				headerRecognized = true
			}
		case "rh_enter_threshold", "rh_enter", "rotorhazard_enter":
			if colRHEnter < 0 {
				colRHEnter = idx
				headerRecognized = true
			}
		case "rh_exit_threshold", "rh_exit", "rotorhazard_exit":
			if colRHExit < 0 {
				colRHExit = idx
				headerRecognized = true
			}
		}
	}

	startRow := 0
	if headerRecognized {
		if colCallsign < 0 {
			return domain.PilotCSVImportSummary{}, fmt.Errorf("CSV header is missing a callsign / pilot name column")
		}
		startRow = 1
	} else {
		// Headerless 1-or-more column CSV: column 0 is callsign, optional column 1 phonetic, optional column 2 channel
		colCallsign = 0
		if len(rawRows[0]) >= 2 {
			colPhonetic = 1
		}
		if len(rawRows[0]) >= 3 {
			colChannel = 2
		}
	}

	cellAt := func(rec []string, col int) string {
		if col < 0 || col >= len(rec) {
			return ""
		}
		return strings.TrimSpace(rec[col])
	}

	parsed := make([]parsedPilotCSVRow, 0, len(rawRows)-startRow)
	for rowIdx := startRow; rowIdx < len(rawRows); rowIdx++ {
		rec := rawRows[rowIdx]
		cs := cellAt(rec, colCallsign)
		if cs == "" {
			continue
		}
		if runes := []rune(cs); len(runes) > 32 {
			cs = string(runes[:32])
		}
		item := parsedPilotCSVRow{
			callsign: cs,
		}
		if colPhonetic >= 0 {
			ph := cellAt(rec, colPhonetic)
			if runes := []rune(ph); len(runes) > 32 {
				ph = string(runes[:32])
			}
			item.hasPhon = true
			item.phonetic = ph
		}
		if colChannel >= 0 {
			rawCh := cellAt(rec, colChannel)
			if band, ch, freq, ok := parseCSVChannelSpec(rawCh); ok {
				item.hasChan = true
				item.band = band
				item.channel = ch
				item.freqMHz = freq
			}
		}
		if colEnter >= 0 {
			if v, err := strconv.ParseFloat(cellAt(rec, colEnter), 32); err == nil {
				item.hasEnter = true
				item.enterDbm = clampDbm(float32(v))
			}
		}
		if colExit >= 0 {
			if v, err := strconv.ParseFloat(cellAt(rec, colExit), 32); err == nil {
				item.hasExit = true
				item.exitDbm = float32(v)
			}
		}
		if colGain >= 0 {
			if v, err := strconv.Atoi(cellAt(rec, colGain)); err == nil {
				if v < 0 {
					v = 0
				} else if v > 63 {
					v = 63
				}
				item.hasGain = true
				item.gain = uint16(v)
			}
		}
		if colLaprfThr >= 0 {
			if v, err := strconv.ParseFloat(cellAt(rec, colLaprfThr), 32); err == nil && v > 0 {
				item.hasLaprfT = true
				item.laprfThr = clampLapRFThreshold(float32(v))
			}
		}
		if colRHEnter >= 0 {
			if v, err := strconv.ParseFloat(cellAt(rec, colRHEnter), 32); err == nil && v > 0 {
				item.hasRHEnter = true
				item.rhEnter = clampRHEnterThreshold(float32(v))
			}
		}
		if colRHExit >= 0 {
			if v, err := strconv.ParseFloat(cellAt(rec, colRHExit), 32); err == nil && v > 0 {
				item.hasRHExit = true
				item.rhExit = float32(v)
			}
		}
		parsed = append(parsed, item)
	}

	if len(parsed) == 0 {
		return domain.PilotCSVImportSummary{}, fmt.Errorf("no pilot rows found in CSV")
	}

	e.mu.Lock()
	maxSlot := 0
	for _, p := range e.pilots {
		if p.SlotIndex > maxSlot {
			maxSlot = p.SlotIndex
		}
	}
	rfLocked := e.isLiveRaceHeatActiveLocked() || e.raceState.Mode == domain.ModeRace

	var addedPilots []domain.PilotSlot
	addedCount := 0
	updatedCount := 0
	seenUpdatedSlots := make(map[int]bool)
	seenAddedSlots := make(map[int]bool)

	for _, row := range parsed {
		existingIdx := -1
		for i := range e.pilots {
			if strings.EqualFold(strings.TrimSpace(e.pilots[i].Callsign), row.callsign) {
				existingIdx = i
				break
			}
		}

		if existingIdx >= 0 {
			cur := e.pilots[existingIdx]
			cur.Callsign = row.callsign
			if row.hasPhon {
				cur.PhoneticName = row.phonetic
			}
			if row.hasEnter {
				cur.EnterThreshold = row.enterDbm
			} else if cur.EnterThreshold == 0 {
				cur.EnterThreshold = -58.0
			}
			if row.hasExit {
				cur.ExitThreshold = clampExitDbm(row.exitDbm, cur.EnterThreshold)
			} else {
				if cur.ExitThreshold == 0 {
					cur.ExitThreshold = cur.EnterThreshold - defaultExitGapDb
				}
				cur.ExitThreshold = clampExitDbm(cur.ExitThreshold, cur.EnterThreshold)
			}
			if row.hasGain {
				cur.AttenuationGain = row.gain
			} else if cur.AttenuationGain == 0 {
				cur.AttenuationGain = domain.DefaultLapRFGain
			}
			if row.hasLaprfT {
				cur.LapRFThreshold = row.laprfThr
			} else if cur.LapRFThreshold <= 0 {
				cur.LapRFThreshold = domain.DefaultLapRFThreshold
			}
			if row.hasRHEnter {
				cur.RHEnterThreshold = row.rhEnter
			} else if cur.RHEnterThreshold <= 0 {
				cur.RHEnterThreshold = domain.DefaultRHEnterThreshold
			}
			if row.hasRHExit {
				cur.RHExitThreshold = clampRHExitThreshold(row.rhExit, cur.RHEnterThreshold)
			} else {
				if cur.RHExitThreshold <= 0 {
					cur.RHExitThreshold = cur.RHEnterThreshold - defaultRHExitGap
				}
				cur.RHExitThreshold = clampRHExitThreshold(cur.RHExitThreshold, cur.RHEnterThreshold)
			}
			if row.hasChan && !rfLocked {
				cur.Band = row.band
				cur.Channel = row.channel
				cur.FrequencyMHz = row.freqMHz
				if cur.Enabled && cur.Channel > 0 {
					for k := range e.pilots {
						if k != existingIdx && e.pilots[k].Enabled && e.pilots[k].Band == cur.Band && e.pilots[k].Channel == cur.Channel {
							e.pilots[k].Channel = 0
							e.pilots[k].FrequencyMHz = 0
						}
					}
				}
			}
			e.pilots[existingIdx] = cur
			for k := range e.practiceSnap.Pilots {
				if e.practiceSnap.Pilots[k].SlotIndex == cur.SlotIndex {
					e.practiceSnap.Pilots[k].Callsign = cur.Callsign
					e.practiceSnap.Pilots[k].PhoneticName = cur.PhoneticName
					e.practiceSnap.Pilots[k].EnterThreshold = cur.EnterThreshold
					e.practiceSnap.Pilots[k].ExitThreshold = cur.ExitThreshold
					e.practiceSnap.Pilots[k].AttenuationGain = cur.AttenuationGain
					e.practiceSnap.Pilots[k].LapRFThreshold = cur.LapRFThreshold
					e.practiceSnap.Pilots[k].RHEnterThreshold = cur.RHEnterThreshold
					e.practiceSnap.Pilots[k].RHExitThreshold = cur.RHExitThreshold
					if row.hasChan {
						e.practiceSnap.Pilots[k].Band = row.band
						e.practiceSnap.Pilots[k].Channel = row.channel
						e.practiceSnap.Pilots[k].FrequencyMHz = row.freqMHz
					}
				}
			}
			if !seenAddedSlots[cur.SlotIndex] && !seenUpdatedSlots[cur.SlotIndex] {
				seenUpdatedSlots[cur.SlotIndex] = true
				updatedCount++
			}
			continue
		}

		maxSlot++
		newSlot := maxSlot
		enterDbm := float32(-58.0)
		if row.hasEnter {
			enterDbm = row.enterDbm
		}
		exitDbm := enterDbm - defaultExitGapDb
		if row.hasExit {
			exitDbm = row.exitDbm
		}
		exitDbm = clampExitDbm(exitDbm, enterDbm)

		gain := uint16(domain.DefaultLapRFGain)
		if row.hasGain {
			gain = row.gain
		}
		laprfThr := float32(domain.DefaultLapRFThreshold)
		if row.hasLaprfT {
			laprfThr = row.laprfThr
		}
		rhEn := float32(domain.DefaultRHEnterThreshold)
		if row.hasRHEnter {
			rhEn = row.rhEnter
		}
		rhEx := rhEn - defaultRHExitGap
		if row.hasRHExit {
			rhEx = row.rhExit
		}
		rhEx = clampRHExitThreshold(rhEx, rhEn)

		band := domain.BandRaceband
		var ch uint8
		var freq uint16
		if row.hasChan {
			band = row.band
			ch = row.channel
			freq = row.freqMHz
		}

		np := domain.PilotSlot{
			SlotIndex:        newSlot,
			Callsign:         row.callsign,
			PhoneticName:     row.phonetic,
			Enabled:          false,
			Band:             band,
			Channel:          ch,
			FrequencyMHz:     freq,
			EnterThreshold:   enterDbm,
			ExitThreshold:    exitDbm,
			LapRFThreshold:   laprfThr,
			RHEnterThreshold: rhEn,
			RHExitThreshold:  rhEx,
			AttenuationGain:  gain,
			Color:            domain.PilotColorForSlot(newSlot),
		}
		e.pilots = append(e.pilots, np)
		if e.practiceSnap.Saved {
			e.practiceSnap.Pilots = append(e.practiceSnap.Pilots, np)
		}
		addedPilots = append(addedPilots, np)
		seenAddedSlots[newSlot] = true
		addedCount++
	}

	e.initDetectorsLocked()
	for i := range addedPilots {
		e.syncGlobalPilotsToOpenEventsLocked(&addedPilots[i], 0)
	}
	e.syncGlobalPilotsToOpenEventsLocked(nil, 0)
	e.syncGlobalPilotsToPracticeSessionsLocked(0)
	if !rfLocked {
		e.syncActivePracticePilotsFromEngineLocked()
	}

	if len(addedPilots) > 0 && e.raceState.Generated && e.raceState.Lifecycle == domain.LifecycleDraft &&
		!e.hasAnyStartedRaceHeatLocked() && !hasAnyManualLocksInState(&e.raceState) {
		if e.raceState.TemplateID != "custom" && len(e.raceState.Stages) <= 2 && !e.hasAnyCustomizedStageLocked() {
			e.regenerateTournamentLocked()
		} else {
			e.rebuildAllUnstartedNonCustomStagesLocked()
			e.resolveActiveTournamentLocked()
		}
	} else if e.raceState.Generated {
		e.resolveActiveTournamentLocked()
	} else {
		e.syncActiveRaceToEventLocked()
	}

	summary := domain.PilotCSVImportSummary{
		Added:   addedCount,
		Updated: updatedCount,
		Total:   len(e.pilots),
	}
	raceSnap := cloneRaceState(e.raceState)
	practiceSnap := clonePracticeManagerState(e.practiceState)
	pilotsCopy := append([]domain.PilotSlot(nil), e.pilots...)
	gatesCopy := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilotsCopy, gatesCopy)
	}
	e.notifyRaceUpdated(raceSnap, nil, subs)
	e.notifyPracticeUpdated(practiceSnap, subs)
	return summary, nil
}
