import { TsGitignoreCorrectlySetPractice } from './TsGitignoreCorrectlySetPractice';
import { gitignoreContent } from '../../detectors/__MOCKS__/JavaScript/gitignoreContent.mock';
import { PracticeEvaluationResult, ProgrammingLanguage } from '../../model';
import { TestContainerContext, createTestContainer } from '../../inversify.config';
import { load } from 'tsconfig';
jest.mock('tsconfig', () => ({
  load: jest.fn(),
}));

const basicGitignore = `
build
node_modules
coverage
.log
`;

describe('TsGitignoreCorrectlySetPractice', () => {
  let practice: TsGitignoreCorrectlySetPractice;
  let containerCtx: TestContainerContext;

  beforeAll(() => {
    containerCtx = createTestContainer();
    containerCtx.container.bind('TsGitignoreCorrectlySetPractice').to(TsGitignoreCorrectlySetPractice);
    practice = containerCtx.container.get('TsGitignoreCorrectlySetPractice');
  });

  afterEach(async () => {
    containerCtx.virtualFileSystemService.clearFileSystem();
    containerCtx.practiceContext.fileInspector!.purgeCache();
  });

  it('Returns practicing if the .gitignore is set correctly', async () => {
    containerCtx.virtualFileSystemService.setFileSystem({
      '.gitignore': gitignoreContent,
    });

    const evaluated = await practice.evaluate(containerCtx.practiceContext);
    expect(evaluated).toEqual(PracticeEvaluationResult.practicing);
  });

  it('Returns notPracticing if there the .gitignore is NOT set correctly', async () => {
    containerCtx.virtualFileSystemService.setFileSystem({
      '.gitignore': '...',
    });

    const evaluated = await practice.evaluate(containerCtx.practiceContext);
    expect(evaluated).toEqual(PracticeEvaluationResult.notPracticing);
    expect(practice.data.details).not.toBeUndefined();
  });

  it('Returns unknown if there is no fileInspector', async () => {
    const evaluated = await practice.evaluate({ ...containerCtx.practiceContext, ...{ root: { fileInspector: undefined } } });
    expect(evaluated).toEqual(PracticeEvaluationResult.unknown);
  });

  it('Returns practicing even if there are no lockfiles in .gitignore', async () => {
    containerCtx.virtualFileSystemService.setFileSystem({
      '.gitignore': basicGitignore,
    });

    const evaluated = await practice.evaluate(containerCtx.practiceContext);
    expect(evaluated).toEqual(PracticeEvaluationResult.practicing);
  });

  it('Returns practicing if there is a lockfile in .gitignore', async () => {
    containerCtx.virtualFileSystemService.setFileSystem({
      '.gitignore': `${basicGitignore}\nyarn.lock`,
    });

    const evaluated = await practice.evaluate(containerCtx.practiceContext);
    expect(evaluated).toEqual(PracticeEvaluationResult.practicing);
  });

  it('Is applicable if programming language is TypeScript ', async () => {
    containerCtx.practiceContext.projectComponent.language = ProgrammingLanguage.TypeScript;
    const result = await practice.isApplicable(containerCtx.practiceContext);
    expect(result).toEqual(true);
  });

  it('Is not applicable if programming language is not TypeScript ', async () => {
    containerCtx.practiceContext.projectComponent.language = ProgrammingLanguage.UNKNOWN;
    const result = await practice.isApplicable(containerCtx.practiceContext);
    expect(result).toEqual(false);
  });

  describe('Fixer', () => {
    beforeEach(() => {
      (load as jest.Mock).mockReturnValue({
        config: {
          compilerOptions: {
            outDir: './lib',
          },
        },
      });
    });

    afterEach(async () => {
      jest.clearAllMocks();
      containerCtx.virtualFileSystemService.clearFileSystem();
    });

    it('Does not change correct .gitignore', async () => {
      const gitignore = `${basicGitignore}\npackage-lock.json\n/lib\n`;
      containerCtx.virtualFileSystemService.setFileSystem({
        '.gitignore': gitignore,
      });

      await practice.evaluate(containerCtx.practiceContext);
      await practice.fix(containerCtx.fixerContext);

      const fixedGitignore = await containerCtx.virtualFileSystemService.readFile('.gitignore');
      expect(fixedGitignore).toBe(gitignore);
    });
    it('Appends to .gitignore if entry is missing', async () => {
      containerCtx.virtualFileSystemService.setFileSystem({
        '.gitignore': '/node_modules\n/coverage\n/lib\n',
      });

      await practice.evaluate(containerCtx.practiceContext);
      await practice.fix(containerCtx.fixerContext);

      const fixedGitignore = await containerCtx.virtualFileSystemService.readFile('.gitignore');
      expect(fixedGitignore).toBe('/node_modules\n/coverage\n/lib\n\n*.log\n');
    });
    it('Correctly ignores build folder', async () => {
      containerCtx.virtualFileSystemService.setFileSystem({
        '.gitignore': '/node_modules\n/coverage\n*.log\n',
      });

      await practice.evaluate(containerCtx.practiceContext);
      await practice.fix(containerCtx.fixerContext);

      const fixedGitignore = await containerCtx.virtualFileSystemService.readFile('.gitignore');
      expect(fixedGitignore).toBe('/node_modules\n/coverage\n*.log\n\n/lib\n');
    });
    it('Correctly ignores build file', async () => {
      (load as jest.Mock).mockReturnValue({
        config: {
          compilerOptions: {
            outFile: './dist.ts',
          },
        },
      });
      containerCtx.virtualFileSystemService.setFileSystem({
        '.gitignore': '/node_modules\n/coverage\n*.log\n',
      });

      await practice.evaluate(containerCtx.practiceContext);
      await practice.fix(containerCtx.fixerContext);

      const fixedGitignore = await containerCtx.virtualFileSystemService.readFile('.gitignore');
      expect(fixedGitignore).toBe('/node_modules\n/coverage\n*.log\n\ndist.ts\n');
    });
  });
});
