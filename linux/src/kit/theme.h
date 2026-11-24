#pragma once

#include <QColor>
#include <QPalette>
#include <QPixmap>

inline const QColor Green{0x2e, 0xa0, 0x43}, Red{0xe5, 0x48, 0x4d}, Orange{0xf0, 0x8c, 0x00};

QColor secondary(const QPalette &p);
// Dividers and tracks: WindowText at alpha 38.
QColor lineColor(const QPalette &p);
// Fixed palettes for --render and the icon tests, independent of the host theme.
QPalette reviewPalette(bool dark);
// 64×64, DPR 1, transparent: the layered glyph, filled when underspent, with a badge for running > 0 or attention (!).
QPixmap trayPixmap(bool filled, int running, const QPalette &p, bool attention = false);
