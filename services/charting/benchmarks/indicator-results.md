# Indicator renderer benchmark

2026-09-20T04:40:47.407Z · ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 SUPER (0x00002783) Direct3D11 vs_5_0 ps_5_0, D3D11) · DPR 1.25

Three repetitions, 60 measured frames per case; five default moving averages, RSI bands/signals and session markers. Precomputed studies shared by both paths. Synthetic redraws; excludes Finance chrome, indicator computation and GPU utilisation measurement. Hidden during run: false.

| Candles | Renderer | Median draw submission | Median frame | P95 frame |
|---|---|---|---|---|
| 250 | svg | 0.50 ms | 6.90 ms | 7.00 ms |
| 250 | canvas | 0.40 ms | 6.90 ms | 7.00 ms |
| 1000 | svg | 2.60 ms | 6.90 ms | 7.00 ms |
| 1000 | canvas | 2.30 ms | 6.90 ms | 7.00 ms |
| 5000 | svg | 12.80 ms | 20.80 ms | 27.80 ms |
| 5000 | canvas | 12.00 ms | 13.90 ms | 14.00 ms |

Hover-only median frame time was approximately 6.9 ms for both renderers at every tested count.
