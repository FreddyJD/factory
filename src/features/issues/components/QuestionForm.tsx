import { useState } from "react";
import type { Question } from "../../../shared/api";
export function QuestionForm({
  request,
  answer,
  disabled,
}: {
  request: Question;
  answer: (value: string[][] | null) => void;
  disabled: boolean;
}) {
  const [answers, setAnswers] = useState<string[][]>(
    request.questions.map(() => []),
  );
  return (
    <form
      className="panel question-form"
      onSubmit={(event) => {
        event.preventDefault();
        answer(answers);
      }}
    >
      <div className="panel-heading">Factory needs input</div>
      <div className="panel-body">
        {request.questions.map((question, index) => (
          <fieldset key={index}>
            <legend>{question.question}</legend>
            {question.options.map((option) => (
              <label key={option.label} className="checkbox-label">
                <input
                  type={question.multiple ? "checkbox" : "radio"}
                  name={`question-${index}`}
                  checked={answers[index].includes(option.label)}
                  onChange={(event) =>
                    setAnswers((current) =>
                      current.map((values, i) =>
                        i !== index
                          ? values
                          : question.multiple
                            ? event.target.checked
                              ? [...values, option.label]
                              : values.filter((v) => v !== option.label)
                            : [option.label],
                      ),
                    )
                  }
                />
                {option.label}
                <span className="muted">{option.description}</span>
              </label>
            ))}
            {question.custom !== false && (
              <input
                className="form-control"
                aria-label="Custom answer"
                onChange={(event) =>
                  setAnswers((current) =>
                    current.map((values, i) =>
                      i === index ? [event.target.value] : values,
                    ),
                  )
                }
              />
            )}
          </fieldset>
        ))}
        <div className="button-row">
          <button
            className="btn btn-success"
            disabled={
              disabled || answers.some((a) => !a.some((value) => value.trim()))
            }
          >
            Answer
          </button>
          <button
            type="button"
            className="btn btn-default"
            disabled={disabled}
            onClick={() => answer(null)}
          >
            Dismiss
          </button>
        </div>
      </div>
    </form>
  );
}
