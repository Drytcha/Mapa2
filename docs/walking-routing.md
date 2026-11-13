# Pedestrian Routing

Walking legs use an OSRM server built with a **foot profile**, not the driving
server used by the operator's route planner. Configure `VITE_WALKING_OSRM_URL`
to point to your own pedestrian OSRM instance for a production deployment.
Changing only the profile name on a driving server does not enable walking.

The default is the FOSSGIS public service:
`https://routing.openstreetmap.de/routed-foot`.
Its policy allows reasonable non-commercial use, no heavy usage, and at most
one request per second. The client serializes requests with a 1.1 second gap,
caches routes in memory for 24 hours, and cancels obsolete searches. For many
users, use your own instance or a suitable hosted service.

Only paths returned by the pedestrian router are shown. Distances and durations
are fed back into the timetable search before a connection can be displayed.
The route must connect to the network within 25 metres of each endpoint.
An unreachable leg is excluded. A service failure produces an explicit error,
never a straight-line or driving-route substitute. Walking times remain
estimates; road closures, incomplete OSM data and individual pace can affect them.

Coordinates are sent to the configured routing service. They are not saved by
the application in persistent storage. FOSSGIS may keep server request logs:
https://routing.openstreetmap.de/about.html