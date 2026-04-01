**Assignment**
Design and implement a system that simulates the operation of a small city in real time and allows testing of various scenarios (transport, weather, events, infrastructure outages).
Your goal is not just to “program something,” but to create a platform that could realistically be used for decision-making.

---

**What the system should do**

**1. City model**

* Representation of streets, intersections, and buildings
* Residents with different behaviors (work, school, leisure)
* Means of transport (cars, public transport, bicycles, pedestrians)

**2. Time simulation**

* Discrete or continuous simulation (choose and justify)
* Events:

  * Traffic accident
  * Road closure
  * Concert / festival
  * Extreme weather

**3. Data & realism**

* Use real data (e.g., OpenStreetMap, open data)
* Work with uncertainty and inaccuracy
* Ability to import external datasets

**4. Intelligence**
Implement at least one of the following:

* Agent-based model (each person = an agent)
* Transport optimization (e.g., traffic lights)
* Prediction (ML model)

**5. Interface**

* Simulation visualization (2D or 3D)
* Dashboard:

  * Traffic density
  * Delays
  * Emissions / consumption

---

**Technical requirements (intentionally open-ended)**

* Backend + frontend (any technologies)
* Scalability (simulation of thousands of entities)
* Modularity (plugins / scenarios)
* API for external use
* Logging and reproducibility of simulations
* “Hidden” challenges (that you’ll encounter yourself)

---

**Bonus challenges**

* Distributed simulation (e.g., across multiple nodes)
* GPU usage / parallelization
* Integration with real data (e.g., weather API)
* “What-if” scenarios (AI suggests measures)
* Multiplayer (multiple users modify the scenario)

---

**Outputs**

* Functional system
* Technical documentation (decisions + trade-offs)
* Demo scenario (“traffic collapse during a concert,” etc.)


