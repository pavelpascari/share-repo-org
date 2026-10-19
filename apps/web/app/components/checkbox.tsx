import type { ReactNode } from "react";
import { Checkbox as AriaCheckbox } from "react-aria-components";

/** A checkbox with a visible box, for forms posted to an action. */
export function Checkbox(props: {
  name: string;
  value: string;
  defaultSelected?: boolean;
  isDisabled?: boolean;
  children: ReactNode;
}) {
  return (
    <AriaCheckbox
      name={props.name}
      value={props.value}
      defaultSelected={props.defaultSelected ?? false}
      isDisabled={props.isDisabled ?? false}
      className="group flex items-center gap-2 data-[disabled]:text-gray-500"
    >
      {({ isSelected }) => (
        <>
          <span
            aria-hidden="true"
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-gray-500 text-xs group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-gray-900"
          >
            {isSelected ? "✓" : ""}
          </span>
          <span>{props.children}</span>
        </>
      )}
    </AriaCheckbox>
  );
}
