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
// "$4.20 of $5 left · expires Nov 20"; empty for a pool with no balance.
QString creditLine(const Snapshot::Pool &p);
// "Acme · $50 grant + $10 purchased · $3 spent this month", unknown parts left out; a Google pool's name reads
// "billing <account id>". Empty when every part is unknown.
QString creditDetail(const Snapshot::Pool &p);
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
// A subscription reading with the credit readings its account owns, or (no reading) a credit reading no reading owns.
struct Account { QString title; std::optional<Snapshot::Reading> reading; QList<Snapshot::Reading> credits; };
// Each credit reading `<key>@<n>` nests under its owner `<agent>@<n>` when that reading exists, else follows all of
// them as `<n> · API credits only · runs under <login>` (without the login part when the reading has none).
QList<Account> accounts(const Snapshot &s);
// The notices whose ids are not in *posted; *posted becomes the snapshot's notice ids, so it never grows unbounded.
QList<Snapshot::Notice> unposted(const Snapshot &s, QStringList *posted);
QString nextText(const Snapshot::Next &n);
QList<Snapshot::Task> shownTasks(const Snapshot &s);
QString taskDetails(const Snapshot::Task &t, double now);

struct Status { enum Kind { Ok, Out, Skipped, Other } kind; QString text; };
Status status(const QString &s);
}
