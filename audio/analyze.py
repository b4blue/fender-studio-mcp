#!/usr/bin/env python3
"""Measure a mix capture (and compare it with a reference).

    analyze.py <file.wav> [--reference ref.wav] [--sections '[{"name","start","end"}]']
               [--segment 10] [--plot out.png]

Prints one JSON object: loudness (integrated, short-term and momentary max, LRA,
per ITU-R BS.1770 / EBU R128, and an ungated mean for comparing short excerpts), peaks (sample, true peak at 4x, crest factor, PLR),
tonal balance per band (share of the total, and the difference from the
reference, so loudness does not matter), the low end below 120 Hz (correlation,
side/mid), stereo correlation over time, width per band, loudness per section,
and a list of flags worth acting on.
"""
import argparse
import json
import sys

import numpy as np
import pyloudnorm as pyln
import soundfile as sf
from scipy import signal

BANDS = [("sub", 20, 60), ("low", 60, 200), ("low_mid", 200, 500), ("mid", 500, 2000), ("presence", 2000, 6000), ("air", 6000, 20000)]
LOW_MONO_HZ = 120
EPS = 1e-20


def db(power):
    return 10 * np.log10(np.maximum(power, EPS))


def r(x, nd=2):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def load(path):
    x, sr = sf.read(path, always_2d=True, dtype="float64")
    if x.shape[1] == 1:
        x = np.repeat(x, 2, axis=1)
    return x[:, :2], sr


# ---- loudness -------------------------------------------------------------------

def k_weighted(x, sr):
    meter = pyln.Meter(sr)
    y = x.copy()
    for f in meter._filters.values():  # BS.1770 pre-filter and RLB high-pass
        for c in range(y.shape[1]):
            y[:, c] = f.apply_filter(y[:, c])
    return y


def window_loudness(kw, sr, win_s, hop_s):
    win, hop = int(win_s * sr), int(hop_s * sr)
    if len(kw) < win:
        return np.array([]), np.array([])
    sq = np.cumsum(np.vstack([np.zeros((1, kw.shape[1])), kw**2]), axis=0)
    starts = np.arange(0, len(kw) - win + 1, hop)
    ms = (sq[starts + win] - sq[starts]) / win
    return (starts + win) / sr, -0.691 + db(ms.sum(axis=1))


def gated_mean(levels, abs_gate=-70.0, rel=-10.0):
    lv = levels[levels > abs_gate]
    if not len(lv):
        return -np.inf
    rel_gate = -0.691 + db(np.mean(10 ** ((lv + 0.691) / 10))) + rel
    lv = lv[lv > rel_gate]
    return -0.691 + db(np.mean(10 ** ((lv + 0.691) / 10))) if len(lv) else -np.inf


def loudness(x, sr):
    kw = k_weighted(x, sr)
    _, mom = window_loudness(kw, sr, 0.4, 0.1)
    st_t, st = window_loudness(kw, sr, 3.0, 0.1)
    integrated = pyln.Meter(sr).integrated_loudness(x) if len(x) >= 0.4 * sr else -np.inf
    lra = None
    if len(st):
        g = st[st > -70]
        if len(g):
            rel_gate = -0.691 + db(np.mean(10 ** ((g + 0.691) / 10))) - 20
            g = g[g > rel_gate]
            if len(g) > 1:
                lra = np.percentile(g, 95) - np.percentile(g, 10)
    # Ungated mean of the 400 ms blocks: for A/B on a short excerpt. Gating (made
    # for whole programmes) can hide a change when quiet blocks sit near the gate.
    mean = -0.691 + db(np.mean(10 ** ((mom + 0.691) / 10))) if len(mom) else -np.inf
    return {
        "integratedLufs": r(integrated),
        "meanLufsUngated": r(mean),
        "shortTermMaxLufs": r(st.max()) if len(st) else None,
        "momentaryMaxLufs": r(mom.max()) if len(mom) else None,
        "lraLu": r(lra),
    }, (st_t, st)


def peaks(x, sr, integrated):
    sample_peak = np.max(np.abs(x))
    up = signal.resample_poly(x, 4, 1, axis=0)
    true_peak = np.max(np.abs(up))
    rms = np.sqrt(np.mean(x**2))
    return {
        "samplePeakDbfs": r(20 * np.log10(max(sample_peak, 1e-10))),
        "truePeakDbtp": r(20 * np.log10(max(true_peak, 1e-10))),
        "rmsDbfs": r(20 * np.log10(max(rms, 1e-10))),
        "crestFactorDb": r(20 * np.log10(max(sample_peak, 1e-10) / max(rms, 1e-10))),
        "plrDb": r(20 * np.log10(max(true_peak, 1e-10)) - integrated) if integrated is not None else None,
        "clippedSamples": int(np.sum(np.abs(x) >= 1.0)),
    }


# ---- spectrum and stereo ----------------------------------------------------------

def psd(x, sr):
    f, p = signal.welch(x, sr, nperseg=min(16384, len(x)), axis=0)
    return f, p.sum(axis=1)


def band_shares(f, p):
    keep = (f >= 20) & (f <= 20000)
    total = np.trapezoid(p[keep], f[keep])
    out = {}
    for name, lo, hi in BANDS:
        m = (f >= lo) & (f < min(hi, f[-1]))
        out[name] = db(np.trapezoid(p[m], f[m]) / total) if m.sum() > 1 else -np.inf
    return out


def smoothed(f, p, frac=6):
    """1/frac-octave smoothed spectrum on a log grid, normalised to its total."""
    keep = (f >= 20) & (f <= 20000)
    total = np.trapezoid(p[keep], f[keep])
    grid = np.geomspace(20, min(20000, f[-1]), 240)
    half = 2 ** (1 / (2 * frac))
    vals = np.array([p[(f >= g / half) & (f <= g * half)].mean() if np.any((f >= g / half) & (f <= g * half)) else np.nan for g in grid])
    return grid, db(vals / total)


def bandpass(x, sr, lo, hi):
    hi = min(hi, 0.45 * sr)
    sos = signal.butter(4, [lo, hi], btype="bandpass", fs=sr, output="sos") if lo > 0 else signal.butter(4, hi, btype="lowpass", fs=sr, output="sos")
    return signal.sosfiltfilt(sos, x, axis=0)


def stereo_of(y):
    mid, side = (y[:, 0] + y[:, 1]) / 2, (y[:, 0] - y[:, 1]) / 2
    em, es = np.sum(mid**2), np.sum(side**2)
    lr = np.sum(y[:, 0] * y[:, 1]) / np.sqrt(max(np.sum(y[:, 0] ** 2) * np.sum(y[:, 1] ** 2), EPS))
    return {"correlation": r(lr), "sideToMidDb": r(db(es / max(em, EPS))), "widthPercent": r(100 * es / max(em + es, EPS), 1)}


def stereo(x, sr):
    win = int(0.4 * sr)
    corr = []
    for s in range(0, len(x) - win + 1, win):
        seg = x[s : s + win]
        if np.sum(seg**2) < 1e-9 * win:  # silence says nothing about phase
            continue
        den = np.sqrt(np.sum(seg[:, 0] ** 2) * np.sum(seg[:, 1] ** 2))
        if den > 0:
            corr.append(np.sum(seg[:, 0] * seg[:, 1]) / den)
    corr = np.array(corr)
    low = stereo_of(bandpass(x, sr, 0, LOW_MONO_HZ))
    return {
        **{k: v for k, v in stereo_of(x).items()},
        "correlationMin": r(corr.min()) if len(corr) else None,
        "negativeCorrelationShare": r(float(np.mean(corr < 0)), 3) if len(corr) else None,
        "lowEnd": {"belowHz": LOW_MONO_HZ, **low, "mono": bool(low["sideToMidDb"] is not None and low["sideToMidDb"] < -20)},
        "widthByBand": width_by_band(x, sr),
    }


def width_by_band(x, sr):
    """Width per band; None for a band more than 60 dB below the whole (noise, not width)."""
    total = np.sum(x**2)
    out = {}
    for name, lo, hi in BANDS:
        if lo >= 0.45 * sr:
            continue
        y = bandpass(x, sr, lo, hi)
        out[name] = stereo_of(y) if np.sum(y**2) > 1e-6 * total else None
    return out


def sections(x, sr, spec, segment):
    if spec:
        parts = spec
    else:
        dur = len(x) / sr
        parts = [{"name": f"{s:g}-{min(s + segment, dur):g}s", "start": s, "end": min(s + segment, dur)} for s in np.arange(0, dur, segment) if min(s + segment, dur) - s >= 1]
    meter = pyln.Meter(sr)
    out = []
    for p in parts:
        seg = x[int(p["start"] * sr) : int(p["end"] * sr)]
        lufs = meter.integrated_loudness(seg) if len(seg) >= 0.4 * sr else -np.inf
        out.append({"name": p["name"], "start": r(p["start"]), "end": r(p["end"]), "lufs": r(lufs), "peakDbfs": r(20 * np.log10(max(np.max(np.abs(seg)) if len(seg) else 0, 1e-10)))})
    return out


# ---- the whole report -----------------------------------------------------------

def measure(path, spec=None, segment=10.0):
    x, sr = load(path)
    loud, st = loudness(x, sr)
    f, p = psd(x, sr)
    return {
        "file": path, "sampleRate": sr, "seconds": r(len(x) / sr),
        "loudness": loud, "peaks": peaks(x, sr, loud["integratedLufs"]),
        "bandShareDb": {k: r(v) for k, v in band_shares(f, p).items()},
        "stereo": stereo(x, sr), "sections": sections(x, sr, spec, segment),
    }, {"st": st, "spectrum": smoothed(f, p)}


def flags(m):
    out = []
    pk, ld, s = m["peaks"], m["loudness"], m["stereo"]
    if pk["truePeakDbtp"] is not None and pk["truePeakDbtp"] > -1:
        out.append(f"true peak {pk['truePeakDbtp']} dBTP is above -1 dBTP" + (f" ({pk['clippedSamples']} samples at or over full scale)" if pk["clippedSamples"] else ""))
    if not s["lowEnd"]["mono"]:
        out.append(f"low end below {LOW_MONO_HZ} Hz is not mono (side/mid {s['lowEnd']['sideToMidDb']} dB, correlation {s['lowEnd']['correlation']}; mono is below -20 dB)")
    if s["negativeCorrelationShare"] and s["negativeCorrelationShare"] > 0.05:
        out.append(f"L/R correlation is negative {round(100 * s['negativeCorrelationShare'])}% of the time (phase problems, mono collapse)")
    if pk["crestFactorDb"] is not None and pk["crestFactorDb"] < 8:
        out.append(f"crest factor {pk['crestFactorDb']} dB: heavily compressed or limited")
    if ld["lraLu"] is not None and ld["lraLu"] < 3 and m["seconds"] >= 30:
        out.append(f"loudness range {ld['lraLu']} LU is very narrow")
    return out


def compare(m, ref):
    bands = {k: {"shareDb": m["bandShareDb"][k], "referenceShareDb": ref["bandShareDb"].get(k), "deltaDb": r(m["bandShareDb"][k] - ref["bandShareDb"][k]) if ref["bandShareDb"].get(k) is not None and m["bandShareDb"][k] is not None else None} for k in m["bandShareDb"]}
    li, ri = m["loudness"]["integratedLufs"], ref["loudness"]["integratedLufs"]
    return {
        "reference": ref["file"],
        "integratedLufsDelta": r(li - ri) if li is not None and ri is not None else None,
        "loudnessDeltaLu": r(m["loudness"]["meanLufsUngated"] - ref["loudness"]["meanLufsUngated"]),
        "truePeakDelta": r(m["peaks"]["truePeakDbtp"] - ref["peaks"]["truePeakDbtp"]),
        "crestFactorDelta": r(m["peaks"]["crestFactorDb"] - ref["peaks"]["crestFactorDb"]),
        "lraDelta": r(m["loudness"]["lraLu"] - ref["loudness"]["lraLu"]) if m["loudness"]["lraLu"] is not None and ref["loudness"]["lraLu"] is not None else None,
        "bands": bands,
        "widthPercentDeltaByBand": {k: r(v["widthPercent"] - ref["stereo"]["widthByBand"][k]["widthPercent"], 1) for k, v in m["stereo"]["widthByBand"].items() if v and ref["stereo"]["widthByBand"].get(k)},
    }


# ---- plot (reference palette: slot 1 this mix, slot 2 the reference) ---------------

INK, INK2, GRID, SURFACE = "#0b0b0b", "#52514e", "#e6e5e0", "#fcfcfb"
THIS, REF = "#2a78d6", "#eb6834"


def plot(path, m, curves, ref=None, ref_curves=None):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.rcParams.update({"font.size": 10, "text.color": INK, "axes.labelcolor": INK2, "xtick.color": INK2, "ytick.color": INK2,
                         "axes.edgecolor": GRID, "axes.facecolor": SURFACE, "figure.facecolor": SURFACE, "axes.grid": True,
                         "grid.color": GRID, "grid.linewidth": 0.8, "axes.axisbelow": True, "axes.spines.top": False, "axes.spines.right": False})
    fig, ax = plt.subplots(2, 2, figsize=(12, 7.5), dpi=120)
    name = lambda p: p.rsplit("/", 1)[-1]
    lab, rlab = f"This mix ({name(m['file'])})", f"Reference ({name(ref['file'])})" if ref else None

    a = ax[0, 0]  # short-term loudness over time
    t, st = curves["st"]
    a.plot(t, st, color=THIS, lw=2, label=lab)
    if ref:
        a.plot(*ref_curves["st"], color=REF, lw=2, label=rlab)
    if m["loudness"]["integratedLufs"] is not None:
        a.axhline(m["loudness"]["integratedLufs"], color=INK2, lw=1, ls="--")
        a.annotate(f"integrated {m['loudness']['integratedLufs']} LUFS", (1, m["loudness"]["integratedLufs"]), xycoords=("axes fraction", "data"), xytext=(-4, 4), textcoords="offset points", ha="right", va="bottom", color=INK2, fontsize=9,
                   bbox={"boxstyle": "round,pad=0.2", "fc": SURFACE, "ec": "none"})
    a.set_title("Short-term loudness (3 s)", loc="left", color=INK)
    a.set_xlabel("seconds")
    a.set_ylabel("LUFS")

    a = ax[0, 1]  # smoothed spectrum
    g, s = curves["spectrum"]
    a.semilogx(g, s, color=THIS, lw=2, label=lab)
    if ref:
        a.semilogx(*ref_curves["spectrum"], color=REF, lw=2, label=rlab)
    for _, lo, _ in BANDS[1:]:
        a.axvline(lo, color=GRID, lw=1)
    a.set_title("Spectrum, 1/6 octave (relative to total)", loc="left", color=INK)
    a.set_xlabel("Hz")
    a.set_ylabel("dB")
    a.set_xlim(20, 20000)

    names = [b[0].replace("_", "-") for b in BANDS]
    xs = np.arange(len(BANDS))
    w = 0.38 if ref else 0.6

    a = ax[1, 0]  # band shares
    vals = [m["bandShareDb"][b[0]] for b in BANDS]
    a.bar(xs - (w / 2 if ref else 0), vals, w, color=THIS, label=lab, edgecolor=SURFACE, linewidth=2)
    if ref:
        a.bar(xs + w / 2, [ref["bandShareDb"][b[0]] for b in BANDS], w, color=REF, label=rlab, edgecolor=SURFACE, linewidth=2)
    a.set_xticks(xs, names)
    a.set_title("Energy per band (dB of total)", loc="left", color=INK)
    a.set_ylabel("dB")

    a = ax[1, 1]  # width per band
    wb = m["stereo"]["widthByBand"]
    keys = [b[0] for b in BANDS if b[0] in wb]
    a.bar(np.arange(len(keys)) - (w / 2 if ref else 0), [wb[k]["widthPercent"] if wb[k] else 0 for k in keys], w, color=THIS, label=lab, edgecolor=SURFACE, linewidth=2)
    if ref:
        rwb = ref["stereo"]["widthByBand"]
        a.bar(np.arange(len(keys)) + w / 2, [rwb[k]["widthPercent"] if rwb.get(k) else 0 for k in keys], w, color=REF, label=rlab, edgecolor=SURFACE, linewidth=2)
    a.set_xticks(np.arange(len(keys)), [k.replace("_", "-") for k in keys])
    a.set_title("Stereo width per band (side share, %)", loc="left", color=INK)
    a.set_ylabel("%")

    if ref:
        for a in ax.flat:
            a.legend(frameon=False, fontsize=8, labelcolor=INK2)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--reference")
    ap.add_argument("--sections", help='JSON list of {"name", "start", "end"} in seconds of the file')
    ap.add_argument("--segment", type=float, default=10.0, help="section length in seconds when --sections is not given")
    ap.add_argument("--plot", help="write a PNG here")
    a = ap.parse_args()
    try:
        spec = json.loads(a.sections) if a.sections else None
        m, curves = measure(a.file, spec, a.segment)
        m["flags"] = flags(m)
        ref = ref_curves = None
        if a.reference:
            ref, ref_curves = measure(a.reference, None, a.segment)
            m["comparison"] = compare(m, ref)
        if a.plot:
            plot(a.plot, m, curves, ref, ref_curves)
            m["plot"] = a.plot
    except Exception as e:  # one JSON line either way, for the server
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        sys.exit(1)
    print(json.dumps(m, indent=1))


if __name__ == "__main__":
    main()
