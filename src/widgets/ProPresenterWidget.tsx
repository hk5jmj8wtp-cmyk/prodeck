import type { ComponentType } from "react";
import { ProPresenterScope, usePpConnection } from "../propresenterStore";
import { ppWidgetSourcePatch, widgetPpInstance } from "../lib/ppWidgets";
import type { WidgetProps } from "./registry";

export function withProPresenterSource(Component: ComponentType<WidgetProps>) {
  return function ProPresenterWidget(props: WidgetProps) {
    const instance = widgetPpInstance(props.widget);
    const { host } = usePpConnection(instance);
    return (
      <div className="pp-widget">
        {props.editing && (
          <label className="pp-widget-source">
            <span>ProPresenter source</span>
            <select className="input" value={instance}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => props.update(ppWidgetSourcePatch(e.target.value === "2" ? 2 : 1))}>
              <option value={1}>ProPresenter</option>
              <option value={2}>propresenter 2</option>
            </select>
          </label>
        )}
        <ProPresenterScope instance={instance}>
          <div className="pp-widget-content">
            <Component key={`${instance}:${host}`} {...props} />
          </div>
        </ProPresenterScope>
      </div>
    );
  };
}
