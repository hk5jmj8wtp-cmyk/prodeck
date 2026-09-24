import type { Widget } from "./dashboards";
import type { ProPresenterInstance } from "./tauri";

export const PP_WIDGET_TYPES = ["slide_preview", "slide_grid", "timer", "lobby_tv", "stage_message"] as const;
export const isPpWidget = (type: string) => (PP_WIDGET_TYPES as readonly string[]).includes(type);
export const widgetPpInstance = (widget: Pick<Widget, "config">): ProPresenterInstance =>
  widget.config.ppInstance === 2 ? 2 : 1;
export const widgetTitle = (label: string, widget: Pick<Widget, "type" | "config">) =>
  isPpWidget(widget.type) && widgetPpInstance(widget) === 2 ? `${label} · propresenter 2` : label;

// IDs and screen indexes belong to one machine. Preserve appearance and
// message presets, but don't carry a selection onto a different computer.
export const ppWidgetSourcePatch = (instance: ProPresenterInstance) => ({
  ppInstance: instance, timerId: null, screenIndex: null,
});
export const dashboardPpInstances = (widgets: Widget[]): ProPresenterInstance[] =>
  [...new Set(widgets.filter((w) => isPpWidget(w.type)).map(widgetPpInstance))];
