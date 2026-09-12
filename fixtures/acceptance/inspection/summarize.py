# Summarize the readings dataset (acceptance fixture).
#
# This program runs on the lightweight Python engine with the data
# directory bound read-only at /mnt/data. It returns one JSON list:
# [row count, lowest value, highest value, anomaly count], where an
# anomaly is any value above ten.

rows = open('/mnt/data/readings.csv').read().strip().split('\n')
values = []
anomalies = 0
for row in rows[1:]:
    parts = row.split(',')
    value = float(parts[2])
    values.append(value)
    if value > 10.0:
        anomalies = anomalies + 1
lowest = values[0]
highest = values[0]
for value in values:
    if value < lowest:
        lowest = value
    if value > highest:
        highest = value
[len(values), lowest, highest, anomalies]
