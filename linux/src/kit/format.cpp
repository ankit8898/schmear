#include "format.h"

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

QString trayLabel(const Snapshot *s)
{
    QStringList parts{QStringLiteral("schmear")};
    if (const int n = runningCount(s); n > 0)
        parts << QStringLiteral("%1 running").arg(n);
    if (underspent(s))
        parts << QStringLiteral("quota to spend");
    return parts.join(QStringLiteral(", "));
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
