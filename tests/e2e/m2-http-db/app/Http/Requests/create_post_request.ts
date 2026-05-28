import { FormRequest, rule } from '@strav/http'

export class CreatePostRequest extends FormRequest<{ title: string; body: string }> {
  override rules() {
    return {
      title: rule.string().min(1).max(255),
      body: rule.string().min(1).max(2000),
    }
  }
}
