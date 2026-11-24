#include "tiereditorplan.h"

static bool sameTiers(const QList<QStringList> &loaded, const QList<QList<TierEntry>> &tiers)
{
    if (loaded.size() != tiers.size())
        return false;
    for (int t = 0; t < tiers.size(); ++t) {
        if (loaded[t].size() != tiers[t].size())
            return false;
        for (int e = 0; e < tiers[t].size(); ++e)
            if (loaded[t][e] != tiers[t][e].spec())
                return false;
    }
    return true;
}

QList<Command> tierEditorSteps(const TiersDoc &loaded, const QList<QList<TierEntry>> &tiers, int maxTasks)
{
    QList<Command> steps;
    if (maxTasks != loaded.maxTasks)
        steps.append({{QStringLiteral("max-tasks"), QString::number(maxTasks)}, {}});
    if (!sameTiers(loaded.tiers, tiers))
        steps.append({{QStringLiteral("tiers"), QStringLiteral("set")}, tiersJson(tiers)});
    return steps;
}
