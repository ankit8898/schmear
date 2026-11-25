#include "format.h"

#include <QDateTime>
#include <QRegularExpression>
#include <algorithm>
#include <cmath>

namespace Format {

QString duration(double seconds)
{
    const int minutes = int(seconds / 60);
    if (minutes < 1)
        return QStringLiteral("<1m");
    if (minutes < 60)
        return QStringLiteral("%1m").arg(minutes);
    const int hours = minutes / 60;
    if (hours < 24) {
        const int m = minutes % 60;
        return m == 0 ? QStringLiteral("%1h").arg(hours) : QStringLiteral("%1h %2m").arg(hours).arg(m);
    }
    const int h = hours % 24;
    return h == 0 ? QStringLiteral("%1d").arg(hours / 24) : QStringLiteral("%1d %2h").arg(hours / 24).arg(h);
}

QString relative(double epochMs, double now)
{
    const double delta = epochMs / 1000 - now;
    if (delta >= 0)
        return delta < 60 ? QStringLiteral("now") : QStringLiteral("in ") + duration(delta);
    return -delta < 60 ? QStringLiteral("just now") : duration(-delta) + QStringLiteral(" ago");
}

QString windowLabel(const Snapshot::Window &w)
{
    const long h = std::lround(w.periodHours);
    return h < 24 || h % 24 != 0 ? QStringLiteral("%1h").arg(h) : QStringLiteral("%1d").arg(h / 24);
}

QString windowLine(const Snapshot::Window &w, double now)
{
    const QString resets = w.resetsAt ? QStringLiteral("resets ") + relative(*w.resetsAt, now)
                                      : QStringLiteral("resets —");
    QString unused;
    if (w.projectedUnused && *w.projectedUnused >= 0.005)
        unused = QStringLiteral(" · ~%1% unused").arg(std::lround(*w.projectedUnused * 100));
    return QStringLiteral("%1 · %2% left · %3%4")
        .arg(windowLabel(w)).arg(std::lround(w.remaining * 100)).arg(resets, unused);
}

static QString dollars(double usd)
{
    const qint64 cents = std::llround(usd * 100);
    return cents % 100 == 0 ? QStringLiteral("$%1").arg(cents / 100)
                            : QString::asprintf("$%.2f", cents / 100.0);
}

QString creditLine(const Snapshot::Pool &p)
{
    if (!p.usd)
        return {};
    QString expires;
    if (!p.windows.isEmpty() && p.windows[0].resetsAt) {
        static const char *const months[] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                             "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
        const QDate d = QDateTime::fromMSecsSinceEpoch(qint64(*p.windows[0].resetsAt)).date();
        // The amount is named only when less than the whole balance expires.
        const auto &e = p.usd->expiring;
        const QString amount = e && p.usd->left - *e >= 0.005 ? dollars(*e) + QLatin1Char(' ') : QString();
        expires = QStringLiteral(" · %1expires %2 %3").arg(amount, QLatin1String(months[d.month() - 1])).arg(d.day());
    }
    const QString of = p.usd->granted > 0 ? QStringLiteral(" of ") + dollars(p.usd->granted) : QString();
    return QStringLiteral("%1%2 left%3").arg(dollars(std::max(0.0, p.usd->left)), of, expires);
}

QString creditDetail(const Snapshot::Pool &p)
{
    QStringList parts;
    if (p.name)
        parts << (p.id.startsWith(QLatin1String("gemini-credits@")) ? QStringLiteral("billing ") + *p.name : *p.name);
    if (p.usd) {
        QStringList split;
        if (p.usd->grant)
            split << dollars(*p.usd->grant) + QStringLiteral(" grant");
        if (p.usd->purchased)
            split << dollars(*p.usd->purchased) + QStringLiteral(" purchased");
        if (!split.isEmpty())
            parts << split.join(QStringLiteral(" + "));
        if (p.usd->spentMonth)
            parts << dollars(*p.usd->spentMonth) + QStringLiteral(" spent this month");
    }
    return parts.join(QStringLiteral(" · "));
}

QString pace(std::optional<double> pace)
{
    return pace ? QString::asprintf("%.2f", *pace) : QStringLiteral("—");
}

QString elapsed(const Snapshot::Task &t, double now)
{
    if (t.status == QLatin1String("running"))
        return QStringLiteral("running ") + duration(now - t.startedAt / 1000);
    QString word = t.status;
    word.replace(QLatin1Char('_'), QLatin1Char(' '));
    return word + QLatin1Char(' ') + relative(t.endedAt.value_or(t.startedAt), now);
}

QString cost(double usd)
{
    return QString::asprintf("$%.4f", usd);
}

int runningCount(const Snapshot *s)
{
    if (!s)
        return 0;
    return int(std::count_if(s->tasks.begin(), s->tasks.end(),
                             [](const Snapshot::Task &t) { return t.status == QLatin1String("running"); }));
}

bool underspent(const Snapshot *s)
{
    if (!s)
        return false;
    for (const auto &r : s->readings)
        for (const auto &p : r.pools)
            if (p.pace.value_or(0) > 1)
                return true;
    return false;
}

static std::optional<QList<int>> versionParts(const QString &version)
{
    static const QRegularExpression pattern(QStringLiteral("^(\\d+)\\.(\\d+)\\.(\\d+)(?:[-+].*)?$"));
    const QRegularExpressionMatch m = pattern.match(version);
    if (!m.hasMatch())
        return std::nullopt;
    return QList<int>{m.captured(1).toInt(), m.captured(2).toInt(), m.captured(3).toInt()};
}

bool cliTooOld(const std::optional<QString> &version)
{
    if (!version)
        return true;
    const auto found = versionParts(*version);
    return !found || *found < *versionParts(MinimumCliVersion);
}

QString cliNotice(const std::optional<QString> &version)
{
    if (!cliTooOld(version))
        return {};
    return QStringLiteral("schmear %1 is too old for this app; it needs %2 or later.")
        .arg(version ? *version : QStringLiteral("older than %1").arg(MinimumCliVersion), MinimumCliVersion);
}

QStringList upgradeCommands()
{
    return {QStringLiteral("brew upgrade schmear && schmear init --yes"), QStringLiteral("npm i -g schmear && schmear init --yes")};
}

bool attention(const Snapshot *s, bool notInstalled)
{
    if (notInstalled)
        return true;
    if (!s)
        return false;
    if (cliTooOld(s->cliVersion))
        return true;
    if (std::any_of(s->hosts.begin(), s->hosts.end(),
                    [](const Snapshot::Host &h) { return h.status != QLatin1String("ok"); }))
        return true;
    return std::none_of(s->readings.begin(), s->readings.end(),
                        [](const Snapshot::Reading &r) { return !r.skipped && !r.pools.isEmpty(); });
}

QString trayLabel(const Snapshot *s, bool notInstalled)
{
    QStringList parts{QStringLiteral("schmear")};
    if (attention(s, notInstalled))
        parts << QStringLiteral("needs attention");
    if (const int n = runningCount(s); n > 0)
        parts << QStringLiteral("%1 running").arg(n);
    if (underspent(s))
        parts << QStringLiteral("quota to spend");
    return parts.join(QStringLiteral(", "));
}

QString hostName(const QString &id)
{
    if (id == QLatin1String("claude"))
        return QStringLiteral("Claude Code");
    if (id == QLatin1String("codex"))
        return QStringLiteral("Codex");
    if (id == QLatin1String("grok"))
        return QStringLiteral("Grok");
    if (id == QLatin1String("opencode"))
        return QStringLiteral("OpenCode");
    if (id == QLatin1String("agy"))
        return QStringLiteral("Antigravity");
    return id;
}

QStringList disconnectedHosts(const Snapshot &s)
{
    QStringList names;
    for (const auto &h : s.hosts)
        if (h.status != QLatin1String("ok"))
            names << hostName(h.id);
    return names;
}

bool nothingConfigured(const Snapshot &s)
{
    return !s.readings.isEmpty()
        && std::all_of(s.readings.begin(), s.readings.end(), [](const Snapshot::Reading &r) {
               return r.skipped == QStringLiteral("not configured");
           });
}

bool lonePool(const Snapshot::Reading &r)
{
    return r.pools.size() == 1 && r.pools[0].id == r.id;
}

// Credit pool `<key>@<n>` belongs to `<agent of key>@<n>`; nullopt for an id that names no credit pool.
static std::optional<std::pair<QString, QString>> creditOwner(const QString &id)
{
    static const QMap<QString, QString> agents{{QStringLiteral("claude-credits"), QStringLiteral("claude")},
                                               {QStringLiteral("gemini-credits"), QStringLiteral("agy")}};
    const qsizetype at = id.lastIndexOf('@');
    const QString agent = at < 0 ? QString() : agents.value(id.left(at));
    if (agent.isEmpty())
        return std::nullopt;
    const QString name = id.mid(at + 1);
    return std::pair{agent + '@' + name, name};
}

QList<Account> accounts(const Snapshot &s)
{
    QList<Account> out;
    for (const auto &r : s.readings)
        if (!creditOwner(r.id))
            out << Account{r.id, r, {}};
    for (const auto &r : s.readings) {
        const auto owner = creditOwner(r.id);
        if (!owner)
            continue;
        const auto it = std::find_if(out.begin(), out.end(),
                                     [&](const Account &a) { return a.reading && a.reading->id == owner->first; });
        if (it != out.end())
            it->credits << r;
        else
            out << Account{owner->second + QStringLiteral(" · API credits only")
                               + (r.login ? QStringLiteral(" · runs under ") + *r.login : QString()),
                           std::nullopt, {r}};
    }
    return out;
}

QList<Snapshot::Notice> unposted(const Snapshot &s, QStringList *posted)
{
    QList<Snapshot::Notice> out;
    QStringList ids;
    for (const auto &n : s.notices) {
        if (!posted->contains(n.id))
            out << n;
        ids << n.id;
    }
    *posted = ids;
    return out;
}

QString nextText(const Snapshot::Next &n)
{
    if (!n.lane)
        return QStringLiteral("none");
    return n.effort ? QStringLiteral("%1 (%2)").arg(*n.lane, *n.effort) : *n.lane;
}

QList<Snapshot::Task> shownTasks(const Snapshot &s)
{
    QList<Snapshot::Task> running, rest;
    for (const auto &t : s.tasks)
        (t.status == QLatin1String("running") ? running : rest) << t;
    const auto newestFirst = [](const Snapshot::Task &a, const Snapshot::Task &b) { return a.startedAt > b.startedAt; };
    std::stable_sort(running.begin(), running.end(), newestFirst);
    std::stable_sort(rest.begin(), rest.end(), newestFirst);
    return (running + rest).mid(0, 10);
}

QString taskDetails(const Snapshot::Task &t, double now)
{
    QStringList parts;
    if (t.lane)
        parts << *t.lane;
    parts << QStringLiteral("tier %1").arg(t.tier) << elapsed(t, now);
    if (t.costUsd)
        parts << cost(*t.costUsd);
    return parts.join(QStringLiteral(" · "));
}

Status status(const QString &s)
{
    if (s == QLatin1String("ok"))
        return {Status::Ok, s};
    if (s.startsWith(QLatin1String("out: ")))
        return {Status::Out, s.mid(5)};
    if (s.startsWith(QLatin1String("skipped: ")))
        return {Status::Skipped, s.mid(9)};
    return {Status::Other, s};
}

}
