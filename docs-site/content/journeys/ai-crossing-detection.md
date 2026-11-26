---
title: AI Crossing Detection & Training
linkTitle: AI Detection & Training
weight: 3
---

SlapRF supports two gate crossing detection modes for Seeed Studio XIAO ESP32-C5 timers: an on-device **AI** neural detector and a traditional **DSP** (`Enter` and `Exit` dBm threshold) detector. You can switch between both modes at any time from the **Track** tab in **Practice** or **Races**.

## AI vs. DSP Detection

| Mode | How It Works | Best For |
| :--- | :--- | :--- |
| **AI (`SlapRF Base` or Custom Model)** | Evaluates the `5.8 GHz` RSSI pass shape over time with a 1D convolutional neural network (`1D-TCN`). Needs no dBm threshold setup. | Flying immediately at `25 mW` to `200 mW+`, multi-gate tracks with varying gate distances, and dipole multipath notches. |
| **DSP (`Enter` and `Exit` Thresholds)** | Opens a crossing window when RSSI rises above `Enter dBm`, tracks the peak, and closes the pass when RSSI drops below `Exit dBm`. | Deterministic dBm cutoff control, bench walk-tests, and setups where you want manual per-gate `Enter` and `Exit` lines. |

## Fly Out of the Box with `SlapRF Base`

SlapRF ships with a built-in model named **`SlapRF Base (1P)`**, pre-trained on verified `5.8 GHz` multi-gate hardware telemetry. You do not need to calibrate dBm thresholds before flying.

1. Open your session's **Track** tab in **Practice** or **Races**.
2. In the **Crossing detector** card, select **`AI`**.
3. Confirm **`SlapRF Base (1P)`** is selected in the model menu.
4. Under **Timing rules**, set **Beep on crossing** to **`On`** (or **`Off`**). In **AI** mode, the app plays a confirmation beep each time the model confirms a gate pass.

> [!TIP]
> **`2L Tune` (Optional)** · Leave **`2L Tune`** off for standard flights with `SlapRF Base` or a custom trained model. Enable **`2L Tune`** only if you want the detector head to adapt on the fly after your first two laps on an unfamiliar gate layout.

## Switch to Traditional DSP Thresholds

If you prefer traditional threshold detection with explicit `Enter` and `Exit` dBm lines, switch the detector to **DSP**:

1. Open the **Track** tab in **Practice** or **Races** and select **`DSP`** in the **Crossing detector** card.
2. Start your session, open **Signals**, and fly 2 to 3 passes through each gate at race speed.
3. Select a timer chip (`H1` or `T1`-`T6`) and tap **Calibrate** to compute `Enter` and `Exit` dBm thresholds from your recorded peaks and noise floor.
4. To adjust thresholds manually, open **Fine-tune** on any selected timer in **Signals**:
   - **Enter Threshold (`dBm`)**: Raise this value (closer to `0 dBm`) if adjacent lanes cause false triggers. Lower it if fast or wide passes are missed.
   - **Exit Threshold (`dBm`)**: Keep this value `6 dB` to `12 dB` below **Enter** so dipole signal dips do not split one pass into two crossings.
   - **Beep on crossing**: Choose **`Off`**, **`Enter`**, **`Peak`**, or **`Exit`**.

## Train or Fine-Tune a Custom AI Model

While `SlapRF Base` works out of the box, you can fine-tune `SlapRF Base` or train a dedicated model on your own sessions to match a specific VTX power level, antenna polarization, indoor venue, or tight gate spacing.

SlapRF records raw `.rfbin` RSSI waveforms automatically during every **Practice** session.

{{% steps %}}

### Record a Practice Session

Connect your timers, start a **Practice** session, and fly one or more battery packs at normal pace. Pause the session when finished.

### Review and Clean Up Crossings

Open the **Review** tab inside your **Practice** session and click **RSSI** on Lap 1 to open the single-lap waveform editor:
- Use **Prev** and **Next** in the chart toolbar to step through each lap.
- If you swapped batteries mid-session without pausing, click **Break** in the modal header during the idle gap so battery-swap dead air is excluded from laps and training data.
- To fix any missed or extra pass, unlock the chart (`Lock` icon), click **`+`** to place a missing gate pass at its RSSI crest, drag existing markers onto the true peak, or click **`×`** on false triggers.
- On desktop builds, you can also click **Auto-Label** to label gate passes in track order automatically.

### Fine-Tune or Train in AI Training

Open the **AI Training** tab inside your **Practice** session:
- **Fine-Tune an Existing Model (Recommended)**: Select **`SlapRF Base`** (or any trained model) in the models list. Check **Include other practices** if you want to combine multiple sessions, then click **Fine-Tune**. SlapRF leaves the original model untouched, saves a new copy named **`SlapRF Base FT`** (followed by **`SlapRF Base FT (1)`**, **`SlapRF Base FT (2)`**, and so on for additional runs), and selects the new copy automatically.
- **Add a Named Model (Train from Scratch or Fine-Tune)**: Type a model name in **Search or add model...** and click **`+ Add`**. Set **Base model** to **`Empty (train from scratch)`** and click **Train**, or choose any trained model in **Base model** and click **Fine-Tune** to adapt it into your new named model.

### Compare Accuracy and Activate

When training finishes (typically under 90 seconds on laptop or phone), inspect the **DSP vs. AI** scorecard (`Passes found`, `False triggers`, and `Accuracy`). Select your new model in the **Track -> Crossing detector** menu to fly with it in **Practice** or **Races**.

{{% /steps %}}

## Share Models and Datasets Across Devices

At the bottom of the **AI Training** tab, use **Export Bundle** and **Import Bundle** to transfer a portable `.tar.gz` archive containing your labeled practice sessions, `.rfbin` waveforms, and trained custom models between your phone and desktop computer.
