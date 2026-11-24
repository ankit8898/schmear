#pragma once

#include "models.h"

// Display strings and view rules. Inputs are epoch ms; `now` is epoch seconds.
namespace Format {
QString duration(double seconds);
QString relative(double epochMs, double now);
QString windowLabel(const Snapshot::Window &w);
QString windowLine(const Snapshot::Window &w, double now);
QString pace(std::optional<double> pace);
QString elapsed(const Snapshot::Task &t, double now);
QString cost(double usd);

int runningCount(const Snapshot *s);
// Pace > 1 means quota expires unused unless spent faster: the cue to delegate.
bool underspent(const Snapshot *s);
bool attention(const Snapshot *s, bool notInstalled);
QString trayLabel(const Snapshot *s, bool notInstalled = false);
QString hostName(const QString &id);
QStringList disconnectedHosts(const Snapshot &s);
bool nothingConfigured(const Snapshot &s);
bool lonePool(const Snapshot::Reading &r);
QString nextText(const Snapshot::Next &n);
QList<Snapshot::Task> shownTasks(const Snapshot &s);
QString taskDetails(const Snapshot::Task &t, double now);

struct Status { enum Kind { Ok, Out, Skipped, Other } kind; QString text; };
Status status(const QString &s);
}
