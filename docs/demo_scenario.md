# Demo Scenario: Traffic Collapse During Concert

Scenario file: `data/scenarios/traffic_collapse_concert.json`

Narrative:
1. Minute 20: accident on key corridor (`e2`) adds heavy congestion.
2. Minute 35: road closure (`e7`) removes alternate bypass route.
3. Minute 45: concert at node `n2` spikes demand and crowd mobility.
4. Minute 55: extreme weather (storm) globally slows traffic.
5. Minute 70: infrastructure outage increases network-wide load.

Expected decision-support outputs:
- Rising traffic density before/after closure.
- Delay growth acceleration after event overlap.
- Emissions and energy spikes due to prolonged trip durations.

How to run:
1. Start backend: `python3 run_backend.py`
2. Start frontend: `python3 run_frontend.py`
3. Open `http://localhost:8080`
4. Run steps and observe dashboard and map congestion colors.

Suggested mitigation experiments:
- Inject extra closures vs. removing closure.
- Inject weather and compare with clear-weather baseline.
- Run with lower resident count to test load sensitivity.
