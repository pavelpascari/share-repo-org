import { TextField as AriaTextField, FieldError, Input, Label, Text } from "react-aria-components";

/** A labelled text input with optional help text and a server-provided error message. */
export function TextField(props: {
  name: string;
  label: string;
  description?: string;
  defaultValue?: string;
  error?: string | undefined;
  isRequired?: boolean;
}) {
  return (
    <AriaTextField
      name={props.name}
      defaultValue={props.defaultValue ?? ""}
      isRequired={props.isRequired ?? false}
      isInvalid={props.error !== undefined}
      validationBehavior="aria"
      className="flex flex-col gap-1"
    >
      <Label className="text-sm font-medium">{props.label}</Label>
      <Input className="rounded border border-gray-300 px-3 py-2 data-[invalid]:border-red-600" />
      {props.description !== undefined && (
        <Text slot="description" className="text-sm text-gray-600">
          {props.description}
        </Text>
      )}
      <FieldError className="text-sm text-red-700">{props.error}</FieldError>
    </AriaTextField>
  );
}
