# Demo script (≈15 minutes)

**Setup:** open https://yield.frontanalytics.com and the Power BI report side by side.

1. **The headline (Power BI → Overview, 2 min).** Over 12 months, first-pass yield is about 76% and final yield about 94%. Rolled throughput yield across the 50 steps matches FPY. That's the executive view, refreshed automatically.
2. **Where yield is lost (app → Overview, 1 min).** The five visual inspection steps account for most first-pass loss, and one measurement step (wireform diameter) stands out.
3. **A measurement problem (app → SPC → Wireform diameter, 3 min).** Split by station: MS-15-2 drifts above USL from mid-May, peaks late June, and is fixed in early July. Cpk is 1.47 for the good station and 0.87 for the drifting one. Click an out-of-spec point to open that valve's full device history and see the rework and re-measure.
4. **A supplier problem (app → Root-cause explorer → Tissue lot, area Tissue, 2 min).** PT-2606-B fails at about 3× the other lots, almost all calcific spots. Go to Image inspections, filter to *Calcific spot*, and show the images.
5. **A people/training problem (Root-cause explorer → Operator, area Assembly, 2 min).** OP-07 runs at about 4× the line average on suture defects, and the rate falls month by month (switch the slice to *Month* with the step set to *Suture line inspection*).
6. **AI-assisted inspection (Image inspections, 3 min).** 97% AI/inspector agreement overall, but the confusion matrix shows the model misses about a third of fiber/particulate defects. Click the "Fiber particle → AI OK" cell to see the images the model missed. This is the business case for a human-review queue and retraining loop (see the architecture doc).
7. **Scale story (docs/architecture.md, 2 min).** The same schema and app run on Azure: Event Hubs, a lakehouse, Azure ML scoring, Container Apps with Entra SSO, and Power BI with RLS, at roughly $1–2k/month for 20–50 users.

**Live data:** the simulator adds new production every 15 minutes, so WIP and "newest first" in the gallery change during the meeting.
