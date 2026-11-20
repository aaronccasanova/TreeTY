export function createAsyncCommandHandler<Arguments extends unknown[], Result>(
  commandHandler: (...commandArguments: Arguments) => Promise<Result>,
  showError: (error: unknown) => void,
): (...commandArguments: Arguments) => Promise<Result> {
  return async (...commandArguments) => {
    try {
      return await commandHandler(...commandArguments);
    } catch (error) {
      showError(error);

      throw error;
    }
  };
}
