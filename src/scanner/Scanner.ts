import debug from 'debug';
import fs from 'fs';
import { inject, injectable, multiInject } from 'inversify';
import os from 'os';
import path from 'path';
import git from 'simple-git/promise';
import url from 'url';
import util, { inspect } from 'util';
import { LanguageContext } from '../contexts/language/LanguageContext';
import { PracticeContext } from '../contexts/practice/PracticeContext';
import { ProjectComponentContext } from '../contexts/projectComponent/ProjectComponentContext';
import { ScannerContext } from '../contexts/scanner/ScannerContext';
import { ScanningStrategy, ScanningStrategyDetector, ServiceType } from '../detectors/ScanningStrategyDetector';
import { ArgumentsProvider } from '../inversify.config';
import {
  LanguageAtPath,
  PracticeEvaluationResult,
  ProjectComponent,
  ProjectComponentFramework,
  ProjectComponentPlatform,
  ProjectComponentType,
  PracticeImpact,
} from '../model';
import { IPracticeWithMetadata } from '../practices/DxPracticeDecorator';
import { IReporter } from '../reporters/IReporter';
import { ScannerContextFactory, Types } from '../types';
import { ScannerUtils } from './ScannerUtils';
import _ from 'lodash';

@injectable()
export class Scanner {
  private readonly scanStrategyDetector: ScanningStrategyDetector;
  private readonly scannerContextFactory: ScannerContextFactory;
  private readonly reporter: IReporter;
  private readonly practices: IPracticeWithMetadata[];
  private readonly argumentsProvider: ArgumentsProvider;
  private readonly scanDebug: debug.Debugger;

  constructor(
    @inject(ScanningStrategyDetector) scanStrategyDetector: ScanningStrategyDetector,
    @inject(Types.ScannerContextFactory) scannerContextFactory: ScannerContextFactory,
    @inject(Types.IReporter) reporter: IReporter,
    // inject all practices registered under Types.Practice in inversify config
    @multiInject(Types.Practice) practices: IPracticeWithMetadata[],
    @inject(Types.ArgumentsProvider) argumentsProvider: ArgumentsProvider,
  ) {
    this.scanStrategyDetector = scanStrategyDetector;
    this.scannerContextFactory = scannerContextFactory;
    this.reporter = reporter;
    this.practices = practices;
    this.argumentsProvider = argumentsProvider;
    this.scanDebug = debug('scanner');
  }

  async scan(): Promise<void> {
    let scanStrategy = await this.scanStrategyDetector.detect();
    this.scanDebug(`Scan strategy: ${inspect(scanStrategy)}`);
    scanStrategy = await this.preprocessData(scanStrategy);
    this.scanDebug(`Scan strategy (after preprocessing): ${inspect(scanStrategy)}`);
    const scannerContext = this.scannerContextFactory(scanStrategy);
    const languagesAtPaths = await this.detectLanguagesAtPaths(scannerContext);
    this.scanDebug(`LanguagesAtPaths:`, inspect(languagesAtPaths));
    const projectComponents = await this.detectProjectComponents(languagesAtPaths, scannerContext, scanStrategy);
    this.scanDebug(`Components:`, inspect(projectComponents));
    const componentsWithPractices = await this.detectPractices(projectComponents);
    await this.report(componentsWithPractices);
  }

  private async preprocessData(scanningStrategy: ScanningStrategy) {
    const { serviceType, accessType, remoteUrl } = scanningStrategy;
    let localPath = scanningStrategy.localPath;

    if (localPath === undefined && remoteUrl !== undefined && serviceType !== ServiceType.local) {
      const cloneUrl = new url.URL(remoteUrl);
      localPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-scanner'));
      await git()
        .silent(true)
        .clone(cloneUrl.href, localPath);
    }

    return { serviceType, accessType, remoteUrl, localPath };
  }

  private async detectLanguagesAtPaths(context: ScannerContext) {
    let languagesAtPaths: LanguageAtPath[] = [];
    for (const languageDetector of context.languageDetectors) {
      languagesAtPaths = [...languagesAtPaths, ...(await languageDetector.detectLanguage())];
    }
    return languagesAtPaths;
  }

  private async detectProjectComponents(languagesAtPaths: LanguageAtPath[], context: ScannerContext, strategy: ScanningStrategy) {
    let components: ProjectComponentAndLangContext[] = [];
    for (const langAtPath of languagesAtPaths) {
      const langContext = context.getLanguageContext(langAtPath);
      await langContext.init();
      const detectors = langContext.getProjectComponentDetectors();
      for (const componentDetector of detectors) {
        const componentsWithContext = (await componentDetector.detectComponent(langAtPath)).map((c) => {
          if (strategy.remoteUrl) {
            c.repositoryPath = strategy.remoteUrl;
          }
          return {
            component: c,
            languageContext: langContext,
          };
        });
        // Add an unknown component for the language at path if we could not detect particular component
        if (langAtPath && componentsWithContext.length === 0) {
          components = [
            ...components,
            {
              languageContext: langContext,
              component: {
                framework: ProjectComponentFramework.UNKNOWN,
                language: langContext.language,
                path: langAtPath.path,
                platform: ProjectComponentPlatform.UNKNOWN,
                type: ProjectComponentType.UNKNOWN,
                repositoryPath: undefined,
              },
            },
          ];
        } else {
          components = [...components, ...componentsWithContext];
        }
      }
    }
    return components;
  }

  private async detectPractices(componentsWithContext: ProjectComponentAndLangContext[]): Promise<PracticeWithContext[]> {
    const practicesWithComponentContext = await Promise.all(componentsWithContext.map((cwctx) => this.detectPracticesForComponent(cwctx)));
    const practicesWithContext = _.flatten(practicesWithComponentContext);

    this.scanDebug('Applicable practices:');
    this.scanDebug(practicesWithContext.map((p) => p.practice.getMetadata().name));

    return practicesWithContext;
  }

  private async report(practicesWithContext: PracticeWithContext[]): Promise<void> {
    const relevantPractices = practicesWithContext;

    const reportString = this.reporter.report(
      relevantPractices.map((p) => {
        const config = p.componentContext.configProvider.getOverriddenPractice(p.practice.getMetadata().id);
        const overridenImpact = config.impact;

        return {
          component: p.componentContext.projectComponent,
          practice: p.practice.getMetadata(),
          evaluation: p.evaluation,
          impact: <PracticeImpact>(overridenImpact ? overridenImpact : p.practice.getMetadata().impact),
          isOn: p.isOn,
        };
      }),
    );

    typeof reportString === 'string'
      ? console.log(reportString)
      : console.log(util.inspect(reportString, { showHidden: false, depth: null }));
  }

  private async detectPracticesForComponent(componentWithCtx: ProjectComponentAndLangContext): Promise<PracticeWithContext[]> {
    const practicesWithContext: PracticeWithContext[] = [];

    const componentContext = componentWithCtx.languageContext.getProjectComponentContext(componentWithCtx.component);
    const practiceContext = componentContext.getPracticeContext();

    await componentContext.configProvider.init();
    const filteredPractices = await ScannerUtils.filterPractices(componentContext, this.practices);

    const orderedApplicablePractices = ScannerUtils.sortPractices(filteredPractices.customApplicablePractices);

    /**
     * Evaluate practices in correct order
     */
    for (const practice of orderedApplicablePractices) {
      const practiceConfig = componentContext.configProvider.getOverriddenPractice(practice.getMetadata().id);

      const isFulfilled = ScannerUtils.isFulfilled(practice, practicesWithContext);

      if (!isFulfilled) continue;
      let evaluation;
      try {
        evaluation = await practice.evaluate({ ...practiceContext, config: practiceConfig });
      } catch (error) {
        evaluation = PracticeEvaluationResult.unknown;
        debug(`The ${practice.getMetadata().name} practice failed with this error:\n${error}`);
      }

      const practiceWithContext = {
        practice,
        componentContext,
        practiceContext,
        evaluation,
        isOn: true,
      };

      practicesWithContext.push(practiceWithContext);
    }

    /**
     * Add turned off practices to result
     */
    for (const practiceOff of filteredPractices.practicesOff) {
      const practiceWithContext = {
        practice: practiceOff,
        componentContext,
        practiceContext,
        evaluation: PracticeEvaluationResult.unknown,
        isOn: false,
      };

      practicesWithContext.push(practiceWithContext);
    }

    return practicesWithContext;
  }
}

interface ProjectComponentAndLangContext {
  component: ProjectComponent;
  languageContext: LanguageContext;
}

export interface PracticeWithContext {
  componentContext: ProjectComponentContext;
  practiceContext: PracticeContext;
  practice: IPracticeWithMetadata;
  evaluation: PracticeEvaluationResult;
  isOn: boolean;
}
