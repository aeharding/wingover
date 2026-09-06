# Flight test fixtures

## Solar reference times

`sun-usno.json` contains sunrise and sunset times retrieved from the
[USNO one-day service](https://aa.usno.navy.mil/data/RS_OneDay) on September 6, 2026. Each row records the public query URL, date, coordinates, and the explicit
UTC offset used by the service. Times are published to the minute. These are
independent test inputs; production does not contact USNO or read the fixture.

## Anonymized RTL tracks

These fixtures contain trimmed kinematics from two real flights that exposed
return-ETA failures. They are test data only and are never loaded by production
code.

Before check-in, each source track was transformed as follows:

- the Earth sphere and every recorded course tangent were rotated to unrelated
  synthetic coordinates;
- absolute timestamps were replaced while preserving elapsed time;
- launch altitude was replaced with a synthetic value, preserving only
  altitude changes relative to launch;
- only the launch fix and the 30-minute estimator history around the regression
  interval were retained; and
- rows were reduced to the `Fix` fields consumed by guidance.

The fixed rotations are multiples of the estimator's 15-degree course bins so
the anonymization does not change bin membership. The compressed payloads do
not contain the original launch coordinates, timestamp, or altitude.
