#pragma once

#include "models.h"

// The oldest `schmear` this app works with: 0.4.0 added `maxTasks` to `schmear tiers` and `hosts` to the snapshot.
constexpr QLatin1String MinimumCliVersion("0.4.0");

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
// A CLI before 0.4.0 reports no version. A pre-release suffix is ignored; an unreadable version counts as too old.
bool cliTooOld(const std::optional<QString> &version);
// The popover's message in place of normal content; empty when the CLI is new enough.
QString cliNotice(const std::optional<QString> &version);
QStringList upgradeCommands();
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
