#pragma once

#include <QByteArray>
#include <QList>
#include <QMap>
#include <QString>
#include <QStringList>
#include <optional>

// `schmear usage --json`. Times are epoch milliseconds.
struct Snapshot {
    struct Host { QString id; QString status; };
    struct Window { double remaining = 0; std::optional<double> resetsAt; double periodHours = 0; std::optional<double> projectedUnused; };
    struct Usd { double left = 0; double granted = 0; };
    // usd: set on a credit pool only.
    struct Pool { QString id; QStringList models; QList<Window> windows; std::optional<Usd> usd; std::optional<double> pace; std::optional<QString> status; };
    struct Reading { QString id; std::optional<QString> skipped; QStringList warnings; QList<Pool> pools; };
    struct Next { int tier = 0; std::optional<QString> lane; std::optional<QString> effort; };
    struct Task { QString description; int tier = 0; QString cwd; std::optional<QString> lane; QString status; std::optional<double> costUsd; double startedAt = 0; std::optional<double> endedAt; };
    std::optional<QString> cliVersion;  // absent from a CLI before 0.4.0
    double at = 0;
    QList<Host> hosts;
    QList<Reading> readings; QList<Next> next; QStringList notOffered; QList<Task> tasks;
};

// `schmear tiers`. Tier entries are "key:model@effort" strings.
struct TiersDoc { QString source; int maxTasks = 0; QList<QStringList> tiers; QStringList laneKeys; QMap<QString, QStringList> offered; };

// On failure: nullopt, and *error is the message shown to the user.
std::optional<Snapshot> decodeSnapshot(const QByteArray &json, QString *error);
std::optional<TiersDoc> decodeTiers(const QByteArray &json, QString *error);

struct TierEntry {
    QString key, model, effort;
    TierEntry() = default;
    explicit TierEntry(QString key);
    // The key ends at the first ':', the effort starts after the last '@' of the rest.
    static TierEntry fromSpec(const QString &spec);
    QString spec() const;
    bool isComplete() const;
};

QByteArray tiersJson(const QList<QList<TierEntry>> &tiers);
