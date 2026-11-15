# Salinity model: what the training results mean

14 Nov 2026

## Short answer

The model is a reasonable early-warning tool, not a precise measurement. It is good at telling which fields are probably fine and which deserve a closer look, and weak at saying exactly how salty a field is. Results are from the 6,798-point LUCAS 2018 training run of 14 Nov 2026 and are reproducible.

## The scores in plain words

Every score comes from a strict test: whole 1°×1° map squares (about 100×100 km) were hidden during training and then predicted. That imitates a farmer's field in a place the model has never seen. Numbers are for the full model.

| Score | What it means | Verdict |
| --- | --- | --- |
| R² 0.32 | Explains about a third of the differences in salinity between fields (0 = always guess the average, 1 = perfect). | Modest |
| Typical error 1.34 | A typical prediction is about 34 % off: a field reading 0.20 dS/m is predicted at roughly 0.15–0.27. | Fine for low values, which is most fields |
| AUC 0.79 | Given one salty and one normal field, it ranks the salty one higher 79 % of the time (50 % = coin flip). | Good: its strongest skill |
| PR-AUC 0.116 (base rate 0.024) | Only 2.4 % of fields are elevated; among its most suspicious picks, elevated fields are about 5× more common than chance. | Useful for ranking, not for a definite "yes, saline" |
| Coverage 0.709 → 0.800 | The raw 80 % ranges held the truth 71 % of the time; after widening, exactly 80 %, tested on held-out data. | Good: the ranges are honest |
| Range width 3.4 | The top of a range is about 3.4× the bottom. | Wide: the price of honesty |
| Coastal, ≤ 20 km from the sea (n = 670) | R² 0.24, AUC 0.72. | The weakest spot |

## Reading the crop table

For maize, the most sensitive crop, the model catches about two-thirds of the fields where salinity really hurts it. At about 9.6 % of points (about 650 fields), measured salinity would cost maize more than 10 % yield.

- **Caught 64 %:** about 420 of those 650 fields were flagged risky or not suitable.
- **Missed 234:** called "safe" although salinity really hurts maize there. These are the dangerous errors.
- **False alarm 18.8 %:** about 1 in 5 fine fields is flagged "risky". That means "worth a soil test", not "don't plant".

For tolerant crops (wheats, barley, cotton, rapeseed) the catch rate is close to zero, but this matters little:

- Only about 1 % of fields hurt them.
- Many of those are inland Spanish gypsum soils, where the damage is probably overstated.
- False alarms are nearly zero, so the model almost never scares a farmer away from a tolerant crop.

## Why it can't be much better with this data

1. **Most of what LUCAS measures isn't salt.** In limestone soils about 0.2 dS/m of the reading is dissolved lime. That is why soil pH is the top feature: the model mainly learned that limestone soils read higher. The source paper (Zarif et al. 2026) also found a model on LUCAS data alone to be weak.
2. **Salty fields are rare.** Only 2.4 % of points are elevated, and only about a dozen of those are near the sea. Coastal salinity can't be learned from twelve examples.
3. **The test is strict on purpose.** The paper's headline R² of 0.6 came from mixing in data from outside Europe and testing on random points near the training points. Under the same strict test it would likely score close to this model.

## Full vs static model

The two models are almost equal, so falling back to the static model in winter costs almost nothing.

| Model | Features | R² all | R² ≤ 20 km from sea | AUC elevated |
| --- | --- | --- | --- | --- |
| Full | 45 | 0.32 | 0.24 | 0.79 |
| Static | 23 | 0.29 | 0.25 | 0.78 |

Near the sea the static model is slightly better, and it catches a few more cases for tolerant crops.

## Bottom line

Use the model as a triage tool: it reliably says "probably fine" for most fields, raises a flag where salt is likely, and gives honest ranges. It should not be the final word on a salty coastal field.

- In the scoring model, apply a salinity penalty in proportion to risk rather than hard pruning.
- A farmer's soil test overrides the model whenever one is available.

The feature-importance list in the training report is measured on the training data, so it shows what the model relies on, not proven causes.
