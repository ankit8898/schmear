#include "models.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonParseError>
#include <utility>

namespace {

// Thrown from nested decoders with the innermost key that failed; caught in decodeVersioned.
struct FieldError { QString key; };

QJsonValue field(const QJsonObject &o, const QString &key, bool required)
{
    const QJsonValue v = o.value(key);
    if (required && (v.isUndefined() || v.isNull()))
        throw FieldError{key};
    return v;
}

double number(const QJsonObject &o, const QString &key)
{
    const QJsonValue v = field(o, key, true);
    if (!v.isDouble())
        throw FieldError{key};
    return v.toDouble();
}

int integer(const QJsonObject &o, const QString &key)
{
    const double d = number(o, key);
    if (d != static_cast<int>(d))
        throw FieldError{key};
    return static_cast<int>(d);
}

QString string(const QJsonObject &o, const QString &key)
{
    const QJsonValue v = field(o, key, true);
    if (!v.isString())
        throw FieldError{key};
    return v.toString();
}

std::optional<double> optionalNumber(const QJsonObject &o, const QString &key)
{
    const QJsonValue v = field(o, key, false);
    if (v.isUndefined() || v.isNull())
        return std::nullopt;
    if (!v.isDouble())
        throw FieldError{key};
    return v.toDouble();
}

std::optional<QString> optionalString(const QJsonObject &o, const QString &key)
{
    const QJsonValue v = field(o, key, false);
    if (v.isUndefined() || v.isNull())
        return std::nullopt;
    if (!v.isString())
        throw FieldError{key};
    return v.toString();
}

QStringList strings(const QJsonValue &v, const QString &key)
{
    if (!v.isArray())
        throw FieldError{key};
    QStringList out;
    for (const QJsonValue &item : v.toArray()) {
        if (!item.isString())
            throw FieldError{key};
        out << item.toString();
    }
    return out;
}

QStringList strings(const QJsonObject &o, const QString &key)
{
    return strings(field(o, key, true), key);
}

template <typename T>
QList<T> objects(const QJsonValue &v, const QString &key, T (*decode)(const QJsonObject &))
{
    if (!v.isArray())
        throw FieldError{key};
    QList<T> out;
    for (const QJsonValue &item : v.toArray()) {
        if (!item.isObject())
            throw FieldError{key};
        out << decode(item.toObject());
    }
    return out;
}

template <typename T>
QList<T> objects(const QJsonObject &o, const QString &key, T (*decode)(const QJsonObject &))
{
    return objects(field(o, key, true), key, decode);
}

Snapshot::Host host(const QJsonObject &o)
{
    Snapshot::Host h;
    h.id = string(o, "id");
    h.status = string(o, "status");
    return h;
}

Snapshot::Window window(const QJsonObject &o)
{
    Snapshot::Window w;
    w.remaining = number(o, "remaining");
    w.resetsAt = optionalNumber(o, "resetsAt");
    w.periodHours = number(o, "periodHours");
    w.projectedUnused = optionalNumber(o, "projectedUnused");
    return w;
}

Snapshot::Pool pool(const QJsonObject &o)
{
    Snapshot::Pool p;
    p.id = string(o, "id");
    const QJsonValue models = field(o, "models", false);
    if (!models.isUndefined() && !models.isNull())
        p.models = strings(models, "models");
    p.windows = objects(o, "windows", window);
    p.pace = optionalNumber(o, "pace");
    p.status = optionalString(o, "status");
    return p;
}

Snapshot::Reading reading(const QJsonObject &o)
{
    Snapshot::Reading r;
    r.id = string(o, "id");
    r.skipped = optionalString(o, "skipped");
    r.warnings = strings(o, "warnings");
    r.pools = objects(o, "pools", pool);
    return r;
}

Snapshot::Next next(const QJsonObject &o)
{
    Snapshot::Next n;
    n.tier = integer(o, "tier");
    n.lane = optionalString(o, "lane");
    n.effort = optionalString(o, "effort");
    return n;
}

Snapshot::Task task(const QJsonObject &o)
{
    Snapshot::Task t;
    t.description = string(o, "description");
    t.tier = integer(o, "tier");
    t.cwd = string(o, "cwd");
    t.lane = optionalString(o, "lane");
    t.status = string(o, "status");
    t.costUsd = optionalNumber(o, "costUsd");
    t.startedAt = number(o, "startedAt");
    t.endedAt = optionalNumber(o, "endedAt");
    return t;
}

Snapshot snapshot(const QJsonObject &o)
{
    Snapshot s;
    s.cliVersion = optionalString(o, "cliVersion");
    s.at = number(o, "at");
    const QJsonValue hosts = field(o, "hosts", false);
    if (!hosts.isUndefined() && !hosts.isNull())
        s.hosts = objects(hosts, "hosts", host);
    s.readings = objects(o, "readings", reading);
    s.next = objects(o, "next", next);
    s.notOffered = strings(o, "notOffered");
    s.tasks = objects(o, "tasks", task);
    return s;
}

TiersDoc tiersDoc(const QJsonObject &o)
{
    TiersDoc t;
    t.source = string(o, "source");
    t.maxTasks = integer(o, "maxTasks");
    const QJsonValue tiers = field(o, "tiers", true);
    if (!tiers.isArray())
        throw FieldError{"tiers"};
    for (const QJsonValue &tier : tiers.toArray())
        t.tiers << strings(tier, "tiers");
    t.laneKeys = strings(o, "laneKeys");
    const QJsonValue offered = field(o, "offered", true);
    if (!offered.isObject())
        throw FieldError{"offered"};
    const QJsonObject offeredObject = offered.toObject();
    for (auto it = offeredObject.begin(); it != offeredObject.end(); ++it)
        t.offered.insert(it.key(), strings(it.value(), it.key()));
    return t;
}

QString unreadable(const QString &detail)
{
    return QStringLiteral("schmear returned output this app cannot read: %1").arg(detail);
}

template <typename T>
std::optional<T> decodeVersioned(const QByteArray &json, QString *error, T (*decode)(const QJsonObject &))
{
    QJsonParseError parseError;
    const QJsonDocument doc = QJsonDocument::fromJson(json, &parseError);
    if (parseError.error != QJsonParseError::NoError) {
        *error = unreadable(parseError.errorString());
        return std::nullopt;
    }
    if (!doc.isObject()) {
        *error = unreadable(QStringLiteral("not a JSON object"));
        return std::nullopt;
    }
    const QJsonObject root = doc.object();
    try {
        const double version = number(root, "version");
        if (version != 1) {
            *error = QStringLiteral("schmear returned data version %1, which this app does not understand. "
                                    "Update the app or schmear.").arg(version);
            return std::nullopt;
        }
        return decode(root);
    } catch (const FieldError &e) {
        *error = unreadable(QStringLiteral("field \"%1\"").arg(e.key));
        return std::nullopt;
    }
}

} // namespace

std::optional<Snapshot> decodeSnapshot(const QByteArray &json, QString *error)
{
    return decodeVersioned(json, error, snapshot);
}

std::optional<TiersDoc> decodeTiers(const QByteArray &json, QString *error)
{
    return decodeVersioned(json, error, tiersDoc);
}

TierEntry::TierEntry(QString key) : key(std::move(key)) {}

TierEntry TierEntry::fromSpec(const QString &spec)
{
    TierEntry e;
    const qsizetype colon = spec.indexOf(':');
    if (colon < 0) {
        e.key = spec;
        return e;
    }
    e.key = spec.left(colon);
    const QString rest = spec.mid(colon + 1);
    const qsizetype at = rest.lastIndexOf('@');
    e.model = at < 0 ? rest : rest.left(at);
    e.effort = at < 0 ? QString() : rest.mid(at + 1);
    return e;
}

QString TierEntry::spec() const
{
    return key + ':' + model + '@' + effort;
}

bool TierEntry::isComplete() const
{
    return !key.trimmed().isEmpty() && !model.trimmed().isEmpty() && !effort.trimmed().isEmpty();
}

QByteArray tiersJson(const QList<QList<TierEntry>> &tiers)
{
    QJsonArray out;
    for (const QList<TierEntry> &tier : tiers) {
        QJsonArray entries;
        for (const TierEntry &e : tier)
            entries.append(e.spec());
        out.append(entries);
    }
    return QJsonDocument(out).toJson(QJsonDocument::Compact);
}
