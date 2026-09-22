import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { getErrorMessage } from "@/shared/api";
import { useRequestsStore, REQUEST_LIMITS, type PartnerRequest } from "@/entities/request";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Textarea } from "@/shared/ui/textarea";
import { createRequestSchema, type CreateRequestField, type CreateRequestValues } from "../model/schema";

type FieldErrors = Partial<Record<CreateRequestField, string>>;

const FIELD_ORDER: CreateRequestField[] = ["subject", "body"];

// Label, hint and error message around one control. The ids `<name>-hint` and
// `<name>-error` are what the control's aria-describedby points at (see controlProps
// below). The error paragraph is always rendered and marked aria-live, so a screen reader
// announces the message when it appears.
function Field({
  name,
  label,
  hint,
  error,
  children,
}: {
  name: CreateRequestField;
  label: string;
  hint: string;
  error: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={name}>{label}</Label>
      {children}
      <p id={`${name}-hint`} className="text-sm text-muted-foreground">
        {hint}
      </p>
      <p id={`${name}-error`} aria-live="polite" className="text-sm text-destructive">
        {error}
      </p>
    </div>
  );
}

// The form keeps its own state in the component: it only matters while the form is open
// and nothing else reads it. The finished request goes to the shared RequestsStore.
export function CreateRequestForm({ onCreated }: { onCreated: (request: PartnerRequest) => void }) {
  const requests = useRequestsStore();
  const [values, setValues] = useState<CreateRequestValues>({ subject: "", body: "" });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const formRef = useRef<HTMLFormElement>(null);
  const submitErrorRef = useRef<HTMLDivElement>(null);

  // After a failed send, move focus to the error so it is announced and easy to find.
  useEffect(() => {
    if (submitError) submitErrorRef.current?.focus();
  }, [submitError]);

  // Everything the three inputs have in common: value, change handler and the ARIA links
  // to their hint and error text.
  function controlProps(field: CreateRequestField) {
    const error = fieldErrors[field];
    return {
      id: field,
      name: field,
      value: values[field],
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        setValues((current) => ({ ...current, [field]: event.target.value }));
      },
      "aria-invalid": error ? true : undefined,
      "aria-describedby": error ? `${field}-hint ${field}-error` : `${field}-hint`,
    };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitError(null);

    const result = createRequestSchema.safeParse(values);
    if (!result.success) {
      // Keep the first message per field, then move focus to the first field with a
      // problem so keyboard and screen reader users land where they have to fix something.
      const errors: FieldErrors = {};
      for (const issue of result.error.issues) {
        const field = issue.path[0] as CreateRequestField;
        errors[field] ??= issue.message;
      }
      setFieldErrors(errors);
      const firstInvalid = FIELD_ORDER.find((field) => errors[field]);
      if (firstInvalid) formRef.current?.querySelector<HTMLElement>(`[name="${firstInvalid}"]`)?.focus();
      return;
    }

    setFieldErrors({});
    setSubmitting(true);
    try {
      // result.data is the trimmed input, exactly what the server will validate.
      const created = await requests.create(result.data);
      onCreated(created);
    } catch (error) {
      setSubmitError(getErrorMessage(error));
      setSubmitting(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={(event) => void handleSubmit(event)} noValidate className="space-y-6">
      <Field
        name="subject"
        label="Subject"
        hint={`A short title, up to ${REQUEST_LIMITS.subject} characters.`}
        error={fieldErrors.subject}
      >
        <Input {...controlProps("subject")} placeholder="e.g. Delivery schedule for next week" autoComplete="off" />
      </Field>

      <Field
        name="body"
        label="Message"
        hint={`The details, up to ${REQUEST_LIMITS.body} characters.`}
        error={fieldErrors.body}
      >
        <Textarea {...controlProps("body")} rows={6} />
      </Field>

      {submitError && (
        <Alert variant="destructive" ref={submitErrorRef} tabIndex={-1}>
          <AlertTitle>The request was not sent</AlertTitle>
          <AlertDescription>{submitError}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" disabled={submitting}>
        {submitting && <LoaderCircle className="animate-spin" aria-hidden="true" />}
        {submitting ? "Sending…" : "Send request"}
      </Button>
    </form>
  );
}
