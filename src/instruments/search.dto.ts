import { Transform } from 'class-transformer';
import { IsString, Length, Matches } from 'class-validator';

const LENGTH = 'q must have 1 to 50 characters';
const NUL = 'q must not contain a NUL byte';

export class SearchQuery {
  // Validated trimmed; the controller trims again because the global pipe does not transform.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: LENGTH })
  @Length(1, 50, { message: LENGTH })
  @Matches(/^[^\0]*$/, { message: ({ value }) => (typeof value === 'string' ? NUL : LENGTH) }) // Postgres text cannot hold it
  q!: string;
}
