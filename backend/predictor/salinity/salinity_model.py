"""
The salinity model itself, shared by train.py (fitting) and predict.py (using it).

Target: log of EC1:5 in mS/m (LUCAS units). Five scikit-learn models per feature set:
  hgb  gradient-boosted trees  \\ averaged -> most likely value (the average beat either one
  rf   random forest           /  alone in spatial cross-validation: R2 0.326 vs 0.317)
  q10  boosted trees, 10th percentile  -> low end of the range
  q90  boosted trees, 90th percentile  -> high end of the range (widened by "conformal", below)
  clf  boosted classifier -> probability that EC1:5 > 0.6 dS/m (the top ~2.5 % of LUCAS)

Only plain scikit-learn objects are stored, so the saved file loads anywhere with the same
scikit-learn version.
"""
import numpy as np
from sklearn.ensemble import (HistGradientBoostingClassifier, HistGradientBoostingRegressor,
                              RandomForestRegressor)

ID_COLS = ["sample_depth", "lucas_point_id", "target_ec_1to5_mS_per_m", "latitude", "longitude"]
TARGET = "target_ec_1to5_mS_per_m"
WINDOW_TAGS = ("_90d", "_60d")       # features measured in the weeks before the date
ELEVATED_MS = 60.0                   # mS/m = 0.6 dS/m EC1:5 (threshold used by Zarif et al. 2026)
RF_FILL = -999.0                     # random forest can't take NaN: missing -> far outside every range

HGB = dict(max_iter=1200, learning_rate=0.02, min_samples_leaf=60, max_leaf_nodes=15,
           l2_regularization=2.0, random_state=0)


def feature_sets(columns):
    full = [c for c in columns if c not in ID_COLS]
    static = [c for c in full if not any(t in c for t in WINDOW_TAGS)]
    return {"full": full, "static": static}


def _hgb(cls=HistGradientBoostingRegressor, **kw):
    try:                                             # feature subsampling (scikit-learn >= 1.4)
        return cls(**HGB, max_features=0.5, **kw)
    except TypeError:
        return cls(**HGB, **kw)


def fit(X, y_log, elevated):
    """X: DataFrame of features, y_log: log(EC mS/m), elevated: 0/1."""
    return {
        "hgb": _hgb().fit(X, y_log),
        "rf": RandomForestRegressor(n_estimators=300, min_samples_leaf=5, max_features=0.33,
                                    n_jobs=-1, random_state=0).fit(X.fillna(RF_FILL), y_log),
        "q10": _hgb(loss="quantile", quantile=0.10).fit(X, y_log),
        "q90": _hgb(loss="quantile", quantile=0.90).fit(X, y_log),
        "clf": _hgb(HistGradientBoostingClassifier).fit(X, elevated),
    }


def predict(models, X, conformal=0.0):
    """Log-space predictions: mid, low, high (+ conformal widening) and P(elevated)."""
    mid = (models["hgb"].predict(X) + models["rf"].predict(X.fillna(RF_FILL))) / 2
    low = np.minimum(models["q10"].predict(X) - conformal, mid)
    high = np.maximum(models["q90"].predict(X) + conformal, mid)
    prob = models["clf"].predict_proba(X)[:, 1]
    return {"mid": mid, "low": low, "high": high, "prob_elevated": prob}


def conformity(y_log, low, high):
    """How far each true value falls outside its range (negative = inside)."""
    return np.maximum(low - y_log, y_log - high)


def conformal_margin(scores, coverage=0.80):
    """Widening that makes `coverage` of the scores fall inside the range."""
    n = len(scores)
    q = min(1.0, np.ceil((n + 1) * coverage) / n)
    return float(max(np.quantile(scores, q), 0.0))
