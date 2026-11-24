#pragma once

#include <QByteArray>
#include <QList>
#include <QStringList>

#include "models.h"

struct Command { QStringList args; QByteArray input; };

// What a tier-editor Save must run: only the parts that differ from the loaded doc, so an
// untouched default list is never written into config.
QList<Command> tierEditorSteps(const TiersDoc &loaded, const QList<QList<TierEntry>> &tiers, int maxTasks);
